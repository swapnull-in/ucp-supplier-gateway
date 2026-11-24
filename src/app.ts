import Fastify, { type FastifyInstance } from "fastify";
import type { CommerceBackend } from "./backend/types.js";
import { namespaceFromOrigin } from "./http.js";
import { registerMcp } from "./mcp.js";
import { type IdempotencyStore, InMemoryIdempotencyStore } from "./idempotency.js";
import type { AccountResolver } from "./ucp/accounts.js";
import { type CartStore, InMemoryCartStore } from "./ucp/cart.js";
import { InMemoryQuoteBook, type QuoteBook } from "./ucp/quote-book.js";
import { registerCartRoutes } from "./ucp/cart-routes.js";
import { errorResponse } from "./ucp/catalog.js";
import { businessProfile } from "./ucp/profile.js";
import { type QuotePolicy, ThresholdQuotePolicy } from "./ucp/quote.js";
import { servedQuoteSchema } from "./ucp/quote-schema.js";
import { registerCatalogRoutes } from "./ucp/routes.js";

export interface AppOptions {
  backend: CommerceBackend;
  accounts: AccountResolver;
  /** Public origin of this gateway, e.g. https://agents.supplier.example */
  publicOrigin: string;
  /** Origin of the merchant's storefront, used to absolutize product URLs. */
  storefrontOrigin: string;
  /** Namespace for vendor capabilities; derived from publicOrigin when omitted. */
  vendorNamespace?: string;
  carts?: CartStore;
  idempotency?: IdempotencyStore;
  quotePolicy?: QuotePolicy;
  quoteBook?: QuoteBook;
  cartTtlMs?: number;
  quotationTtlMs?: number;
  /** Enables the admin routes (answer or withdraw cart quotes, issue out-of-band quotes) when set. */
  adminToken?: string;
  now?: () => Date;
  logger?: boolean;
}

const SHOPPING_BASE = "/ucp";
const DAY_MS = 24 * 3600_000;

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? { redact: ["req.headers.authorization", 'req.headers["x-admin-token"]'] } : false,
    bodyLimit: 256 * 1024,
  });

  // Keep the raw bytes: UCP compares idempotent retries by SHA-256 of the raw body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      const err = new Error("Malformed JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, "unhandled error");
    return reply.code(status).send(errorResponse(status === 500 ? "internal_error" : "invalid_request", status === 500 ? "Internal error" : err.message));
  });

  const namespace = opts.vendorNamespace ?? namespaceFromOrigin(opts.publicOrigin);
  // Mirrors the proposed dev.ucp.common.quote (#929) under our own authority until it's released.
  const quoteCapability = `${namespace}.common.quote`;
  const quoteSchemaUrl = `${opts.publicOrigin}${SHOPPING_BASE}/schemas/quote.json`;

  app.get("/.well-known/ucp", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return businessProfile({ publicOrigin: opts.publicOrigin, shoppingBase: SHOPPING_BASE, quoteCapability, quoteSchemaUrl });
  });

  app.get(`${SHOPPING_BASE}/schemas/quote.json`, async (_req, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return servedQuoteSchema(quoteSchemaUrl, quoteCapability);
  });

  registerCatalogRoutes(app, SHOPPING_BASE, {
    backend: opts.backend,
    accounts: opts.accounts,
    storefrontOrigin: opts.storefrontOrigin,
  });

  const cartDeps: Parameters<typeof registerCartRoutes>[2] = {
    backend: opts.backend,
    accounts: opts.accounts,
    carts: opts.carts ?? new InMemoryCartStore(),
    idempotency: opts.idempotency ?? new InMemoryIdempotencyStore(),
    quotePolicy: opts.quotePolicy ?? new ThresholdQuotePolicy(),
    quoteBook: opts.quoteBook ?? new InMemoryQuoteBook(),
    quoteCapability,
    cartTtlMs: opts.cartTtlMs ?? 7 * DAY_MS,
    quotationTtlMs: opts.quotationTtlMs ?? 7 * DAY_MS,
    now: opts.now ?? (() => new Date()),
  };
  if (opts.adminToken) cartDeps.adminToken = opts.adminToken;
  registerCartRoutes(app, SHOPPING_BASE, cartDeps);

  // UCP MCP binding over the same routes.
  registerMcp(app, `${SHOPPING_BASE}/mcp`, SHOPPING_BASE);

  return app;
}
