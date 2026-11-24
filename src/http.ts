import type { FastifyReply, FastifyRequest } from "fastify";
import type { BuyerAccount } from "./backend/types.js";
import type { AccountResolver } from "./ucp/accounts.js";
import { errorResponse } from "./ucp/catalog.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact request bytes, kept for idempotency fingerprints (and later, Content-Digest checks). */
    rawBody?: Buffer;
  }
}

/** Extracts the platform profile URL from the RFC 8941 dictionary in UCP-Agent. */
export function platformProfile(req: FastifyRequest): URL | undefined {
  const header = req.headers["ucp-agent"];
  const match = typeof header === "string" ? /(?:^|[,;\s])profile="([^"]+)"/.exec(header) : null;
  if (!match) return undefined;
  try {
    const url = new URL(match[1]!);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function requirePlatform(req: FastifyRequest, reply: FastifyReply): URL | undefined {
  const profile = platformProfile(req);
  if (!profile) {
    void reply.code(400).send(errorResponse("invalid_request", 'UCP-Agent header with profile="https://..." is required'));
  }
  return profile;
}

export type AuthResult =
  | { ok: true; account?: BuyerAccount }
  | { ok: false };

/**
 * Resolves the optional bearer token to a buyer account and checks `scope`.
 * Sends the 401/403 itself; callers return early when `ok` is false.
 */
export async function authenticate(
  req: FastifyRequest,
  reply: FastifyReply,
  accounts: AccountResolver,
  scope: string,
): Promise<AuthResult> {
  const header = req.headers.authorization;
  if (!header) return { ok: true };
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const grant = token ? await accounts.resolve(token) : undefined;
  if (!grant) {
    void reply.code(401).send(errorResponse("unauthorized", "Invalid or expired access token"));
    return { ok: false };
  }
  if (!grant.scopes.includes(scope)) {
    void reply.code(403).send(errorResponse("insufficient_scope", `Token lacks ${scope}`));
    return { ok: false };
  }
  return { ok: true, account: grant.account };
}

/**
 * Derives a reverse-domain namespace from a public origin, so vendor capability schemas
 * served from that origin pass UCP's authority binding (https://agents.supplier.example ->
 * example.supplier.agents).
 */
export function namespaceFromOrigin(origin: string): string {
  const labels = new URL(origin).hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2) throw new Error(`Cannot derive a UCP namespace from single-label host in ${origin}; set vendorNamespace`);
  return labels.reverse().join(".");
}
