import { buildApp } from "./app.js";
import { OccBackend } from "./backend/occ/client.js";
import { buildMockOcc } from "./backend/occ/mock-server.js";
import { SCOPE_CART_MANAGE, SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH, StaticAccountResolver } from "./ucp/accounts.js";

// Local demo: a mock SAP OCC storefront plus the gateway in front of it.
const OCC_PORT = Number(process.env.MOCK_OCC_PORT ?? 9002);
const PORT = Number(process.env.PORT ?? 8080);
const OCC_BASE_URL = process.env.OCC_BASE_URL ?? `http://127.0.0.1:${OCC_PORT}`;

if (!process.env.OCC_BASE_URL) {
  await buildMockOcc().listen({ port: OCC_PORT, host: "127.0.0.1" });
}

// localhost has no reverse-domain form, so the demo uses a placeholder namespace. In production
// it is derived from PUBLIC_ORIGIN so served capability schemas pass UCP authority binding.
const NAMESPACE = process.env.VENDOR_NAMESPACE ?? "com.example.gateway";
const scopes = [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP, SCOPE_CART_MANAGE];

// Demo identity-linking grants: UCP access token -> buyer account, and account -> OCC token.
const accounts = new StaticAccountResolver({
  "demo-token-acme": { account: { id: "acme_industrial", name: "Acme Industrial" }, scopes },
  "demo-token-northwind": { account: { id: "northwind_mro", name: "Northwind MRO" }, scopes },
});
const occTokens: Record<string, string> = { acme_industrial: "occ-token-acme", northwind_mro: "occ-token-northwind" };

const app = buildApp({
  backend: new OccBackend({
    baseUrl: OCC_BASE_URL,
    siteId: process.env.OCC_SITE_ID ?? "powertools",
    tokenFor: async (account) => occTokens[account.id],
  }),
  accounts,
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`,
  storefrontOrigin: process.env.STOREFRONT_ORIGIN ?? "https://supplier.example",
  vendorNamespace: NAMESPACE,
  // Lets the demo answer pending quote proposals: POST /admin/carts/:id/quote
  ...(process.env.ADMIN_TOKEN ? { adminToken: process.env.ADMIN_TOKEN } : {}),
  logger: true,
});

await app.listen({ port: PORT, host: "127.0.0.1" });
