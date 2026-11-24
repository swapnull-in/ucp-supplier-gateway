import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { OccBackend } from "../src/backend/occ/client.js";
import { buildMockOcc } from "../src/backend/occ/mock-server.js";
import { SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH, StaticAccountResolver } from "../src/ucp/accounts.js";
import { UcpSchemas } from "../src/ucp/schemas.js";

const schemas = new UcpSchemas();
const AGENT = { "ucp-agent": 'profile="https://agent.example/profile.json"' };

let occ: FastifyInstance;
let app: FastifyInstance;

beforeAll(async () => {
  occ = buildMockOcc();
  const occUrl = await occ.listen({ port: 0, host: "127.0.0.1" });
  app = buildApp({
    backend: new OccBackend({
      baseUrl: occUrl,
      siteId: "powertools",
      tokenFor: async (a) => ({ acme_industrial: "occ-token-acme" })[a.id],
    }),
    accounts: new StaticAccountResolver({
      "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes: [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP] },
      "tok-noscope": { account: { id: "acme_industrial", name: "Acme" }, scopes: [] },
    }),
    publicOrigin: "https://agents.supplier.example",
    storefrontOrigin: "https://supplier.example",
  });
});

afterAll(async () => {
  await app.close();
  await occ.close();
});

function search(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/ucp/catalog/search", payload: body as object, headers: { ...AGENT, ...headers } });
}

function expectValid(schemaRef: string, data: unknown) {
  const result = schemas.validate(schemaRef, data);
  expect(result.valid ? [] : result.errors).toEqual([]);
}

describe("GET /.well-known/ucp", () => {
  it("serves a business profile that validates against the UCP profile schema", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/ucp" });
    expect(res.statusCode).toBe(200);
    expectValid("profile.json#/$defs/business_schema", res.json());
    expect(res.json().ucp.services["dev.ucp.shopping"][0].endpoint).toBe("https://agents.supplier.example/ucp");
  });
});

describe("POST /ucp/catalog/search", () => {
  it("returns schema-valid products at list price for anonymous platforms", async () => {
    const res = await search({ query: "hex bolt" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectValid("shopping/catalog_search.json#/$defs/search_response", body);
    expect(body.products.map((p: { id: string }) => p.id)).toEqual(["HX-1040", "HX-1060"]);
    expect(body.products[0].variants[0].price).toEqual({ amount: 2490, currency: "USD" });
    expect(body.products[0].url).toBe("https://supplier.example/p/HX-1040");
    expect(body.messages).toBeUndefined();
  });

  it("returns the linked buyer account's contract prices", async () => {
    const res = await search({ query: "hex bolt" }, { authorization: "Bearer tok-acme" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectValid("shopping/catalog_search.json#/$defs/search_response", body);
    // Acme's contract is 18% off list: 24.90 -> 20.42
    expect(body.products[0].variants[0].price).toEqual({ amount: 2042, currency: "USD" });
    expect(body.messages[0].code).toBe("account_pricing");
  });

  it("maps out-of-stock items as unavailable", async () => {
    const body = (await search({ query: "nut" })).json();
    expect(body.products[0].variants[0].availability).toEqual({ available: false, status: "out_of_stock" });
  });

  it("caps the page size", async () => {
    const body = (await search({ query: "", pagination: { limit: 2 } })).json();
    expect(body.products).toHaveLength(2);
  });

  it("requires a UCP-Agent profile", async () => {
    const res = await app.inject({ method: "POST", url: "/ucp/catalog/search", payload: { query: "bolt" } });
    expect(res.statusCode).toBe(400);
    expectValid("common/types/error_response.json", res.json());
  });

  it("rejects unknown tokens and tokens without the catalog scope", async () => {
    const bad = await search({ query: "bolt" }, { authorization: "Bearer nope" });
    expect(bad.statusCode).toBe(401);
    expectValid("common/types/error_response.json", bad.json());

    const noScope = await search({ query: "bolt" }, { authorization: "Bearer tok-noscope" });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().messages[0].code).toBe("insufficient_scope");
  });

  it("returns a UCP error when the backend is down", async () => {
    const down = buildApp({
      backend: new OccBackend({ baseUrl: "http://127.0.0.1:1", siteId: "x", timeoutMs: 500 }),
      accounts: new StaticAccountResolver({}),
      publicOrigin: "https://agents.supplier.example",
      storefrontOrigin: "https://supplier.example",
    });
    const res = await down.inject({ method: "POST", url: "/ucp/catalog/search", payload: { query: "bolt" }, headers: AGENT });
    expect(res.statusCode).toBe(500);
    expectValid("common/types/error_response.json", res.json());
    await down.close();
  });
});

describe("POST /ucp/catalog/lookup", () => {
  const lookup = (ids: unknown, headers: Record<string, string> = { ...AGENT, authorization: "Bearer tok-acme" }) =>
    app.inject({ method: "POST", url: "/ucp/catalog/lookup", headers, payload: { ids } as object });

  it("returns schema-valid products with correlation, account pricing and not_found messages", async () => {
    const res = await lookup(["HX-1040", "NOPE", "HX-1040"]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectValid("shopping/catalog_lookup.json#/$defs/lookup_response", body);
    expect(body.products).toHaveLength(1);
    expect(body.products[0].variants[0].inputs).toEqual([{ id: "HX-1040", match: "exact" }]);
    expect(body.products[0].variants[0].price).toEqual({ amount: 2042, currency: "USD" });
    expect(body.messages).toContainEqual({ type: "info", code: "not_found", content: "NOPE" });
  });

  it("rejects empty and oversized batches", async () => {
    expect((await lookup([], AGENT)).statusCode).toBe(400);
    const big = await lookup(Array.from({ length: 51 }, (_, i) => `id-${i}`), AGENT);
    expect(big.statusCode).toBe(400);
    expect(big.json().messages[0].code).toBe("request_too_large");
  });
});
