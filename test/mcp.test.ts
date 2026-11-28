import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { OccBackend } from "../src/backend/occ/client.js";
import { buildMockOcc } from "../src/backend/occ/mock-server.js";
import { UCP_PROTOCOL_ERROR } from "../src/mcp.js";
import { SCOPE_CART_MANAGE, SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH, SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ, StaticAccountResolver } from "../src/ucp/accounts.js";
import { DRAFT_QUOTE_ID, loadDraftQuoteSchema } from "../src/ucp/quote-schema.js";
import { UcpSchemas } from "../src/ucp/schemas.js";

const META = { "ucp-agent": { profile: "https://agent.example/profile.json" } };
const schemas = new UcpSchemas();
schemas.addSchema(loadDraftQuoteSchema());

let occ: FastifyInstance;
let app: FastifyInstance;
let mcpUrl: URL;

beforeAll(async () => {
  occ = buildMockOcc();
  const occUrl = await occ.listen({ port: 0, host: "127.0.0.1" });
  const scopes = [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP, SCOPE_CART_MANAGE, SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ];
  app = buildApp({
    backend: new OccBackend({ baseUrl: occUrl, siteId: "powertools", tokenFor: async (a) => ({ acme_industrial: "occ-token-acme" })[a.id] }),
    accounts: new StaticAccountResolver({ "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes } }),
    publicOrigin: "https://agents.supplier.example",
    storefrontOrigin: "https://supplier.example",
  });
  mcpUrl = new URL("/ucp/mcp", await app.listen({ port: 0, host: "127.0.0.1" }));
});

afterAll(async () => {
  await app.close();
  await occ.close();
});

/** A real MCP client over streamable HTTP, optionally with a linked-account token. */
async function connect(token?: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const requestInit = token ? { headers: { authorization: `Bearer ${token}` } } : {};
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit }));
  return client;
}

const structured = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;

describe("UCP MCP binding", () => {
  it("lists the UCP shopping tools that are implemented", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_cart", "cancel_checkout", "complete_checkout", "create_cart", "create_checkout", "get_cart", "get_checkout",
      "get_order", "lookup_catalog", "search_catalog", "update_cart", "update_checkout",
    ]);
    expect(tools.find((t) => t.name === "get_cart")!.inputSchema.required).toEqual(["meta", "id"]);
    await client.close();
  });

  it("searches the catalog with account pricing and returns structuredContent", async () => {
    const client = await connect("tok-acme");
    const result = await client.callTool({ name: "search_catalog", arguments: { meta: META, catalog: { query: "hex bolt" } } });
    const body = structured(result);
    const valid = schemas.validate("shopping/catalog_search.json#/$defs/search_response", body);
    expect(valid.valid ? [] : valid.errors).toEqual([]);
    expect(body.products[0].variants[0].price).toEqual({ amount: 2042, currency: "USD" });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(body);
    await client.close();
  });

  it("runs a quote cycle on a cart: request a firm quote, then accept it by id", async () => {
    const client = await connect("tok-acme");
    const line_items = [{ item: { id: "SG-220" }, quantity: 100 }];
    const created = structured(await client.callTool({ name: "create_cart", arguments: { meta: META, cart: { line_items, quote: { proposal: {} } } } }));
    expect(created.quote.status).toBe("quoted");

    const accepted = structured(await client.callTool({
      name: "update_cart",
      arguments: { meta: META, id: created.id, cart: { line_items, quote: { accepted_id: created.quote.id } } },
    }));
    const valid = schemas.validateAbsolute(`${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.cart`, accepted);
    expect(valid.valid ? [] : valid.errors).toEqual([]);
    expect(accepted.quote).toMatchObject({ status: "accepted", accepted_id: created.quote.id });

    const fetched = structured(await client.callTool({ name: "get_cart", arguments: { meta: META, id: created.id } }));
    expect(fetched.quote.status).toBe("accepted");
    await client.close();
  });

  it("checks out a quoted cart and reads the order", async () => {
    const client = await connect("tok-acme");
    const line_items = [{ item: { id: "SG-220" }, quantity: 100 }];
    const cart = structured(await client.callTool({ name: "create_cart", arguments: { meta: META, cart: { line_items, quote: { proposal: {} } } } }));
    await client.callTool({ name: "update_cart", arguments: { meta: META, id: cart.id, cart: { line_items, quote: { accepted_id: cart.quote.id } } } });
    const checkout = structured(await client.callTool({ name: "create_checkout", arguments: { meta: META, checkout: { cart_id: cart.id, line_items: [] } } }));
    expect(checkout.quote).toMatchObject({ status: "accepted", id: cart.quote.id });
    const done = structured(await client.callTool({
      name: "complete_checkout",
      arguments: { meta: { ...META, "idempotency-key": "mcp-complete-1" }, id: checkout.id, checkout: { payment: {} } },
    }));
    expect(done.status).toBe("completed");
    const order = structured(await client.callTool({ name: "get_order", arguments: { meta: META, id: done.order.id } }));
    expect(order.quote).toEqual({ id: cart.quote.id, subtotal: cart.quote.subtotal });
    expect(order.payment.accepted_term.id).toBe("net_30");
    await client.close();
  });

  it("honours meta idempotency-key across retries", async () => {
    const client = await connect("tok-acme");
    const args = { meta: { ...META, "idempotency-key": "mcp-retry-1" }, cart: { line_items: [{ item: { id: "SG-220" }, quantity: 2 }] } };
    const first = structured(await client.callTool({ name: "create_cart", arguments: args }));
    const second = structured(await client.callTool({ name: "create_cart", arguments: args }));
    expect(second.id).toBe(first.id);
    await client.close();
  });

  it("returns business outcomes as results, and protocol failures as JSON-RPC -32000", async () => {
    const client = await connect("tok-acme");
    const missing = structured(await client.callTool({ name: "get_cart", arguments: { meta: META, id: "cart_nope" } }));
    expect(missing.ucp.status).toBe("error");
    expect(missing.messages[0].code).toBe("not_found");
    await client.close();

    const badToken = await connect("tok-wrong");
    await expect(badToken.callTool({ name: "search_catalog", arguments: { meta: META, catalog: { query: "bolt" } } }))
      .rejects.toMatchObject({ code: UCP_PROTOCOL_ERROR });
    await badToken.close();
  });

  it("serves a bare tools/call with no initialize and an HTTP library's default Accept", async () => {
    // As Google's ADK commerce codelab client sends it (httpx: Accept */*).
    for (const accept of ["*/*", undefined]) {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "search_catalog", arguments: { meta: META, catalog: { query: "bolt" } } } }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).result.structuredContent.products.length).toBeGreaterThan(0);
    }
  });

  it("rejects calls without the required ucp-agent metadata", async () => {
    const client = await connect();
    await expect(client.callTool({ name: "search_catalog", arguments: { catalog: { query: "bolt" } } }))
      .rejects.toMatchObject({ code: -32602 });
    await client.close();
  });
});
