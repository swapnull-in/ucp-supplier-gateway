import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { OccBackend } from "../src/backend/occ/client.js";
import { buildMockOcc } from "../src/backend/occ/mock-server.js";
import type { CatalogProduct, CommerceBackend } from "../src/backend/types.js";
import { SCOPE_CART_MANAGE, SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH, StaticAccountResolver } from "../src/ucp/accounts.js";
import { DRAFT_QUOTE_ID, loadDraftQuoteSchema } from "../src/ucp/quote-schema.js";
import { UcpSchemas } from "../src/ucp/schemas.js";

const ORIGIN = "https://agents.supplier.example";
const NS = "example.supplier.agents";
const AGENT = { "ucp-agent": 'profile="https://agent.example/profile.json"' };
const ACME = { ...AGENT, authorization: "Bearer tok-acme" };
const NORTHWIND = { ...AGENT, authorization: "Bearer tok-northwind" };
const CART_WITH_QUOTE = `${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.cart`;

const schemas = new UcpSchemas();
schemas.addSchema(loadDraftQuoteSchema());

function expectValid(result: { valid: true } | { valid: false; errors: string[] }) {
  expect(result.valid ? [] : result.errors).toEqual([]);
}

let occ: FastifyInstance;
let app: FastifyInstance;
let clock: Date;

function makeApp(backend: CommerceBackend) {
  const scopes = [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP, SCOPE_CART_MANAGE];
  return buildApp({
    backend,
    accounts: new StaticAccountResolver({
      "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes },
      "tok-northwind": { account: { id: "northwind_mro", name: "Northwind" }, scopes },
      "tok-catalog-only": { account: { id: "acme_industrial", name: "Acme" }, scopes: [SCOPE_CATALOG_SEARCH] },
    }),
    publicOrigin: ORIGIN,
    storefrontOrigin: "https://supplier.example",
    adminToken: "admin-secret",
    now: () => clock,
  });
}

beforeAll(async () => {
  occ = buildMockOcc();
  const occUrl = await occ.listen({ port: 0, host: "127.0.0.1" });
  app = makeApp(new OccBackend({
    baseUrl: occUrl,
    siteId: "powertools",
    tokenFor: async (a) => ({ acme_industrial: "occ-token-acme", northwind_mro: "occ-token-northwind" })[a.id],
  }));
});

beforeEach(() => {
  clock = new Date("2026-11-24T12:00:00Z");
});

afterAll(async () => {
  await app.close();
  await occ.close();
});

const lines = (...l: [string, number][]) => l.map(([id, quantity]) => ({ item: { id }, quantity }));
const create = (body: object, headers: Record<string, string> = ACME) => app.inject({ method: "POST", url: "/ucp/carts", headers, payload: body });
const update = (id: string, body: object, headers: Record<string, string> = ACME) => app.inject({ method: "PUT", url: `/ucp/carts/${id}`, headers, payload: body });
const get = (id: string, headers: Record<string, string> = ACME) => app.inject({ method: "GET", url: `/ucp/carts/${id}`, headers });
const totalOf = (body: { totals: { type: string; amount: number }[] }, type: string) => body.totals.find((t) => t.type === type)?.amount;

describe("profile and served schema", () => {
  it("advertises cart, checkout, order, payment terms and the quote extension, authority-bound to our origin", async () => {
    const profile = (await app.inject({ method: "GET", url: "/.well-known/ucp" })).json();
    expectValid(schemas.validate("profile.json#/$defs/business_schema", profile));
    const quote = profile.ucp.capabilities[`${NS}.common.quote`][0];
    expect(quote).toMatchObject({ extends: ["dev.ucp.shopping.cart", "dev.ucp.shopping.checkout", "dev.ucp.shopping.order"], schema: `${ORIGIN}/ucp/schemas/quote.json` });
    expect(profile.ucp.capabilities["dev.ucp.common.payment.terms"][0].extends).toEqual(["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"]);
    const reversed = new URL(quote.schema).hostname.split(".").reverse().join(".");
    expect(`${NS}.common.quote`.startsWith(`${reversed}.`)).toBe(true);
  });

  it("serves the draft schema with our $id and absolute refs into ucp.dev", async () => {
    const served = (await app.inject({ method: "GET", url: "/ucp/schemas/quote.json" })).json();
    expect(served.$id).toBe(`${ORIGIN}/ucp/schemas/quote.json`);
    expect(served.name).toBe(`${NS}.common.quote`);
    expect(JSON.stringify(served)).not.toContain('"$ref":"../');
    expect(served.$defs["dev.ucp.shopping.cart"].allOf[0].$ref).toBe("https://ucp.dev/schemas/shopping/cart.json");
  });
});

describe("cart", () => {
  it("creates a schema-valid cart with account and volume pricing and an idle quote", async () => {
    const res = await create({ line_items: lines(["HX-1040", 500], ["SG-220", 10]) });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, body));
    // Acme contract 24.90 * 0.82 = 20.42, then the 500+ break at 90% = 18.38
    expect(body.line_items[0]).toMatchObject({ item: { id: "HX-1040", price: 1838 }, quantity: 500, totals: [{ type: "subtotal", amount: 919_000 }] });
    expect(totalOf(body, "subtotal")).toBe(919_000 + 10 * 3936);
    expect(totalOf(body, "total")).toBe(totalOf(body, "subtotal"));
    expect(body.quote).toEqual({});
    expect(body.expires_at).toBe("2026-12-01T12:00:00.000Z");
  });

  it("anonymous carts get list prices and no quote extension", async () => {
    const body = (await create({ line_items: lines(["HX-1040", 10]) }, AGENT)).json();
    expectValid(schemas.validate("shopping/cart.json", body));
    expect(body.line_items[0].item.price).toBe(2490);
    expect(body.quote).toBeUndefined();
    const withQuote = await create({ line_items: lines(["HX-1040", 10]), quote: { proposal: {} } }, AGENT);
    expect(withQuote.statusCode).toBe(400);
  });

  it("reports minimum-order and stock problems as messages on the lines", async () => {
    const body = (await create({ line_items: lines(["HX-1040", 2], ["HX-1060", 100], ["GHOST", 1]) })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, body));
    expect(body.messages.map((m: { code: string }) => m.code).sort()).toEqual(["insufficient_stock", "item_unavailable", "quantity_below_minimum"]);
  });

  it("returns an error instead of a cart when nothing can be ordered", async () => {
    const res = await create({ line_items: lines(["GHOST", 1]) });
    expect(res.statusCode).toBe(200);
    expectValid(schemas.validate("common/types/error_response.json", res.json()));
    expect(res.json().ucp.status).toBe("error");
  });

  it("updates by full replacement, re-pricing the new lines", async () => {
    const id = (await create({ line_items: lines(["HX-1040", 10]) })).json().id;
    const body = (await update(id, { line_items: lines(["SG-220", 2]) })).json();
    expect(body.line_items.map((l: { item: { id: string } }) => l.item.id)).toEqual(["SG-220"]);
  });

  it("hides other accounts' carts, expires carts, and returns state on cancel", async () => {
    const id = (await create({ line_items: lines(["SG-220", 1]) })).json().id;
    expect((await get(id, NORTHWIND)).statusCode).toBe(404);
    const canceled = await app.inject({ method: "POST", url: `/ucp/carts/${id}/cancel`, headers: ACME });
    expect(canceled.json().id).toBe(id);
    expect((await get(id)).statusCode).toBe(404);

    const id2 = (await create({ line_items: lines(["SG-220", 1]) })).json().id;
    clock = new Date("2026-12-02T00:00:00Z");
    expect((await get(id2)).statusCode).toBe(404);
  });

  it("validates request bodies", async () => {
    for (const bad of [{}, { line_items: [] }, { line_items: lines(["X", 0]) }, { line_items: lines(["X", 1.5]) }, { line_items: lines(["X", 1], ["X", 2]) }]) {
      expect((await create(bad)).statusCode).toBe(400);
    }
    expect((await create({ line_items: lines(["SG-220", 1]), quote: { proposal: { subtotal: -1 } } })).statusCode).toBe(400);
    expect((await create({ line_items: lines(["SG-220", 1]) }, { ...AGENT, authorization: "Bearer tok-catalog-only" })).statusCode).toBe(403);
  });
});

describe("quote extension (UCP #929) on the cart", () => {
  it("firm quote, then accept by id: totals carry exactly one signed quote entry", async () => {
    const cart = (await create({ line_items: lines(["SG-220", 100]), quote: { proposal: {} } })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, cart));
    expect(cart.quote).toMatchObject({ status: "quoted", subtotal: 393_600, expires_at: "2026-12-01T12:00:00.000Z" });

    const accepted = (await update(cart.id, { line_items: lines(["SG-220", 100]), quote: { accepted_id: cart.quote.id } })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, accepted));
    expect(accepted.quote).toMatchObject({ status: "accepted", id: cart.quote.id, accepted_id: cart.quote.id });
    // A firm quote at the current price: the adjustment is zero, but it's still pinned.
    expect(accepted.totals.filter((t: { type: string }) => t.type === "quote")).toHaveLength(1);
    expect(totalOf(accepted, "total")).toBe(393_600);
  });

  it("an accepted quotation holds the price; changing quantities invalidates it", async () => {
    const cart = (await create({ line_items: lines(["SG-220", 100]), quote: { proposal: { subtotal: 385_000 } } })).json();
    expect(cart.quote).toMatchObject({ status: "accepted", subtotal: 385_000, proposal: { subtotal: 385_000 } });
    expect(totalOf(cart, "quote")).toBe(385_000 - 393_600);
    expect(totalOf(cart, "total")).toBe(385_000);

    const changed = (await update(cart.id, { line_items: lines(["SG-220", 120]) })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, changed));
    expect(changed.quote).toEqual({});
    expect(totalOf(changed, "quote")).toBeUndefined();
    expect(changed.messages).toContainEqual(expect.objectContaining({ type: "warning", code: "quote_changed" }));
  });

  it("a pending proposal is answered by the Business, then accepted by the Buyer", async () => {
    const cart = (await create({ line_items: lines(["SG-220", 100]), quote: { proposal: { subtotal: 360_000, message: "Quarterly order" } } })).json();
    expect(cart.quote.status).toBe("pending");

    const deny = await app.inject({ method: "POST", url: `/admin/carts/${cart.id}/quote`, payload: { status: "quoted", subtotal: 370_000 } });
    expect(deny.statusCode).toBe(401);
    const answer = await app.inject({ method: "POST", url: `/admin/carts/${cart.id}/quote`, headers: { "x-admin-token": "admin-secret" }, payload: { status: "quoted", subtotal: 370_000, message: "Approved by sales" } });
    expect(answer.statusCode).toBe(200);

    const quoted = (await get(cart.id)).json();
    expect(quoted.quote).toMatchObject({ status: "quoted", subtotal: 370_000, message: "Approved by sales" });
    const accepted = (await update(cart.id, { line_items: lines(["SG-220", 100]), quote: { accepted_id: quoted.quote.id } })).json();
    expect(totalOf(accepted, "total")).toBe(370_000);
  });

  it("declines lowball proposals and fails closed on stale ids", async () => {
    const cart = (await create({ line_items: lines(["SG-220", 100]), quote: { proposal: { subtotal: 100_000 } } })).json();
    expect(cart.quote.status).toBe("declined");
    const stale = (await update(cart.id, { line_items: lines(["SG-220", 100]), quote: { accepted_id: "qt_nope" } })).json();
    expect(stale.quote.status).toBe("declined");
    expect(stale.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
  });
});

describe("Business-side flows: withdraw and out-of-band quotations", () => {
  const ADMIN = { "x-admin-token": "admin-secret" };
  const admin = (url: string, payload: object) => app.inject({ method: "POST", url, headers: ADMIN, payload });

  it("withdrawing an accepted quotation removes the price and tells the Buyer once", async () => {
    const cart = (await create({ line_items: lines(["SG-220", 100]), quote: { proposal: { subtotal: 385_000 } } })).json();
    expect(cart.quote.status).toBe("accepted");
    expect((await admin(`/admin/carts/${cart.id}/quote`, { status: "withdrawn" })).statusCode).toBe(200);

    const after = (await get(cart.id)).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, after));
    expect(after.quote).toEqual({ status: "withdrawn", id: cart.quote.id, subtotal: 385_000 });
    expect(totalOf(after, "quote")).toBeUndefined();
    expect(totalOf(after, "total")).toBe(393_600);
    expect(after.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
    expect((await get(cart.id)).json().messages ?? []).not.toContainEqual(expect.objectContaining({ code: "quote_changed" }));
  });

  it("a sales-desk quotation is accepted on a cart with the same items in any order", async () => {
    const issued = await admin("/admin/quotes", { account_id: "acme_industrial", currency: "USD", subtotal: 380_000, line_items: lines(["SG-220", 50], ["HX-1040", 100]) });
    expect(issued.statusCode).toBe(201);
    const qid = issued.json().id;

    const cart = (await create({ line_items: lines(["HX-1040", 100], ["SG-220", 50]), quote: { accepted_id: qid } })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, cart));
    expect(cart.quote).toMatchObject({ status: "accepted", id: qid, accepted_id: qid, subtotal: 380_000 });
    // Current account price: 100 x 19.40 (100+ break) + 50 x 39.36 = 3,908.00; the desk quoted 3,800.00
    expect(totalOf(cart, "quote")).toBe(380_000 - 390_800);
    expect(totalOf(cart, "total")).toBe(380_000);
  });

  it("fails closed with quote_changed for extra lines or another account", async () => {
    const qid = (await admin("/admin/quotes", { account_id: "acme_industrial", currency: "USD", subtotal: 30_000, line_items: lines(["SG-220", 10]) })).json().id;

    const extra = (await create({ line_items: lines(["SG-220", 10], ["HX-1040", 5]), quote: { accepted_id: qid } })).json();
    expect(extra.quote).toEqual({});
    expect(extra.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));

    const other = (await create({ line_items: lines(["SG-220", 10]), quote: { accepted_id: qid } }, NORTHWIND)).json();
    expect(other.quote).toEqual({});
    expect(other.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
  });

  it("admin routes require the admin token and valid input", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/quotes", payload: {} })).statusCode).toBe(401);
    expect((await admin("/admin/quotes", { account_id: "acme_industrial", currency: "usd", subtotal: 1, line_items: lines(["SG-220", 1]) })).statusCode).toBe(400);
  });
});

describe("price falls after acceptance (raised on #929)", () => {
  it("the cart never charges more than the current account price", async () => {
    let unit = 4800;
    const backend: CommerceBackend = {
      searchProducts: async () => [],
      getProducts: async (): Promise<CatalogProduct[]> => [{ id: "SG-220", title: "Gloves", description: "", categories: [], price: { amount: unit, currency: "USD" }, stock: { status: "in_stock" } }],
    };
    const local = makeApp(backend);
    const req = (method: "POST" | "PUT" | "GET", url: string, payload?: object) =>
      local.inject({ method, url, headers: ACME, ...(payload ? { payload } : {}) });

    const cart = (await req("POST", "/ucp/carts", { line_items: lines(["SG-220", 10]), quote: { proposal: { subtotal: 47_000 } } })).json();
    expect(cart.quote).toMatchObject({ status: "accepted", subtotal: 47_000 });
    expect(totalOf(cart, "total")).toBe(47_000);

    unit = 4500; // the account's price list drops
    const after = (await req("GET", `/ucp/carts/${cart.id}`)).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, after));
    expect(after.quote).toMatchObject({ status: "quoted", subtotal: 45_000 });
    expect(after.quote.id).not.toBe(cart.quote.id);
    expect(after.totals.some((t: { type: string }) => t.type === "quote")).toBe(false);
    expect(totalOf(after, "total")).toBe(45_000);
    expect(after.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));

    // The old id no longer resolves; the new one is accepted only when the Buyer sends it.
    const stale = (await req("PUT", `/ucp/carts/${cart.id}`, { line_items: lines(["SG-220", 10]), quote: { accepted_id: cart.quote.id } })).json();
    expect(stale.quote).toMatchObject({ status: "quoted", id: after.quote.id });
    expect(stale.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
    const accepted = (await req("PUT", `/ucp/carts/${cart.id}`, { line_items: lines(["SG-220", 10]), quote: { accepted_id: after.quote.id } })).json();
    expectValid(schemas.validateAbsolute(CART_WITH_QUOTE, accepted));
    expect(accepted.quote).toMatchObject({ status: "accepted", id: after.quote.id, accepted_id: after.quote.id });
    expect(totalOf(accepted, "total")).toBe(45_000);
    await local.close();
  });
});

describe("idempotency on carts", () => {
  const body = JSON.stringify({ line_items: lines(["SG-220", 3]) });
  const post = (payload: string, key: string, headers = ACME) =>
    app.inject({ method: "POST", url: "/ucp/carts", headers: { ...headers, "content-type": "application/json", "idempotency-key": key }, payload });

  it("replays the original response instead of creating a second cart", async () => {
    const first = await post(body, "c-1");
    const second = await post(body, "c-1");
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects a reused key with different bytes, and scopes keys per account", async () => {
    await post(body, "c-2");
    expect((await post(JSON.stringify({ line_items: [{ quantity: 3, item: { id: "SG-220" } }] }), "c-2")).statusCode).toBe(409);
    const nw = await post(body, "c-2", NORTHWIND);
    expect(nw.statusCode).toBe(201);
  });

  it("does not store server errors, so the key can be retried", async () => {
    let fail = true;
    const flaky: CommerceBackend = {
      searchProducts: async () => [],
      getProducts: async (): Promise<CatalogProduct[]> => {
        if (fail) throw new Error("OCC down");
        return [{ id: "SG-220", title: "Gloves", description: "", categories: [], price: { amount: 4800, currency: "USD" }, stock: { status: "in_stock" } }];
      },
    };
    const flakyApp = makeApp(flaky);
    const req = () => flakyApp.inject({ method: "POST", url: "/ucp/carts", headers: { ...ACME, "content-type": "application/json", "idempotency-key": "k" }, payload: body });
    expect((await req()).statusCode).toBe(500);
    fail = false;
    expect((await req()).statusCode).toBe(201);
    await flakyApp.close();
  });
});
