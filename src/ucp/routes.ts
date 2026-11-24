import type { FastifyInstance } from "fastify";
import type { CommerceBackend } from "../backend/types.js";
import { authenticate, requirePlatform } from "../http.js";
import { type AccountResolver, SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH } from "./accounts.js";
import { DEFAULT_LIMIT, MAX_LIMIT, catalogResponse, errorResponse, toUcpProduct } from "./catalog.js";

export const MAX_LOOKUP_IDS = 50;

interface Deps {
  backend: CommerceBackend;
  accounts: AccountResolver;
  storefrontOrigin: string;
}

export function registerCatalogRoutes(app: FastifyInstance, base: string, deps: Deps) {
  app.post<{ Body: { query?: unknown; pagination?: { limit?: unknown } } }>(`${base}/catalog/search`, async (req, reply) => {
    if (!requirePlatform(req, reply)) return reply;
    const auth = await authenticate(req, reply, deps.accounts, SCOPE_CATALOG_SEARCH);
    if (!auth.ok) return reply;

    const limit = clampLimit(req.body?.pagination?.limit);
    const text = typeof req.body?.query === "string" ? req.body.query : "";
    try {
      const products = await deps.backend.searchProducts(auth.account ? { text, limit, account: auth.account } : { text, limit });
      return catalogResponse("dev.ucp.shopping.catalog.search", products.map((p) => toUcpProduct(p, deps.storefrontOrigin)), auth.account !== undefined);
    } catch (err) {
      req.log.error({ err }, "catalog search failed");
      return reply.code(500).send(errorResponse("backend_unavailable", "The catalog is temporarily unavailable"));
    }
  });

  app.post<{ Body: { ids?: unknown } }>(`${base}/catalog/lookup`, async (req, reply) => {
    if (!requirePlatform(req, reply)) return reply;
    const auth = await authenticate(req, reply, deps.accounts, SCOPE_CATALOG_LOOKUP);
    if (!auth.ok) return reply;

    const raw = req.body?.ids;
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((id) => typeof id === "string" && id.length > 0)) {
      return reply.code(400).send(errorResponse("invalid_request", "ids must be a non-empty array of strings"));
    }
    // Duplicate identifiers MUST be deduplicated (lookup.md, "Supported Identifiers").
    const ids = [...new Set(raw as string[])];
    if (ids.length > MAX_LOOKUP_IDS) {
      return reply.code(400).send(errorResponse("request_too_large", `At most ${MAX_LOOKUP_IDS} ids per lookup`));
    }

    try {
      const products = await deps.backend.getProducts(ids, auth.account);
      const found = new Set(products.map((p) => p.id));
      // Product id and SKU are the same in this backend, so every hit is an exact variant match.
      const ucpProducts = products.map((p) => toUcpProduct(p, deps.storefrontOrigin, [{ id: p.id, match: "exact" }]));
      const response = catalogResponse("dev.ucp.shopping.catalog.lookup", ucpProducts, auth.account !== undefined);
      const missing = ids.filter((id) => !found.has(id)).map((id) => ({ type: "info", code: "not_found", content: id }));
      if (missing.length) response.messages = [...((response.messages as unknown[]) ?? []), ...missing];
      return response;
    } catch (err) {
      req.log.error({ err }, "catalog lookup failed");
      return reply.code(500).send(errorResponse("backend_unavailable", "The catalog is temporarily unavailable"));
    }
  });
}

function clampLimit(limit: unknown): number {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
}
