import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CatalogProduct, CommerceBackend } from "../src/backend/types.js";
import {
  SCOPE_CART_MANAGE,
  SCOPE_CATALOG_LOOKUP,
  SCOPE_CATALOG_SEARCH,
  SCOPE_CHECKOUT_MANAGE,
  SCOPE_ORDER_READ,
  StaticAccountResolver,
} from "../src/ucp/accounts.js";
import { DRAFT_QUOTE_ID, loadDraftQuoteSchema } from "../src/ucp/quote-schema.js";
import { UcpSchemas } from "../src/ucp/schemas.js";

const AGENT = { "ucp-agent": 'profile="https://agent.example/profile.json"' };
const ACME = { ...AGENT, authorization: "Bearer tok-acme" };
const NORTHWIND = { ...AGENT, authorization: "Bearer tok-northwind" };
const TERMS_ID = "https://ucp.dev/schemas/common/payment_terms.json";

const schemas = new UcpSchemas();
schemas.addSchema(loadDraftQuoteSchema());

function expectValid(result: { valid: true } | { valid: false; errors: string[] }) {
  expect(result.valid ? [] : result.errors).toEqual([]);
}

/** A checkout response is checked against both extensions that extend it. */
function expectValidCheckout(body: unknown) {
  expectValid(schemas.validateAbsolute(`${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.checkout`, body));
  expectValid(schemas.validateAbsolute(`${TERMS_ID}#/$defs/dev.ucp.shopping.checkout`, body));
}

function expectValidOrder(body: unknown) {
  expectValid(schemas.validateAbsolute(`${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.order`, body));
  expectValid(schemas.validateAbsolute(`${TERMS_ID}#/$defs/dev.ucp.shopping.order`, body));
}

let app: FastifyInstance;
let clock: Date;
let unit: number;

const backend: CommerceBackend = {
  searchProducts: async () => [],
  getProducts: async (ids): Promise<CatalogProduct[]> =>
    ids.filter((id) => id === "SG-220").map((id) => ({
      id, title: "Safety gloves", description: "", categories: [], price: { amount: unit, currency: "USD" }, stock: { status: "in_stock" as const },
    })),
};

beforeAll(() => {
  const scopes = [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP, SCOPE_CART_MANAGE, SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ];
  app = buildApp({
    backend,
    accounts: new StaticAccountResolver({
      "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes },
      "tok-northwind": { account: { id: "northwind_mro", name: "Northwind" }, scopes },
    }),
    publicOrigin: "https://agents.supplier.example",
    storefrontOrigin: "https://supplier.example",
    now: () => clock,
  });
});

beforeEach(() => {
  clock = new Date("2026-11-25T12:00:00Z");
  unit = 4800;
});

afterAll(async () => {
  await app.close();
});

type Body = Record<string, any>;
const lines = (quantity: number) => [{ item: { id: "SG-220" }, quantity }];
const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: object, headers: Record<string, string> = ACME) => {
  const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as Body };
};
const totalOf = (body: Body, type: string) => body.totals.find((t: { type: string }) => t.type === type)?.amount;

/** A cart for 10 gloves at 4800 with a quotation accepted at 47,000 (within 3% of 48,000). */
async function acceptedCart() {
  const cart = await call("POST", "/ucp/carts", { line_items: lines(10), quote: { proposal: { subtotal: 47_000 } } });
  expect(cart.body.quote).toMatchObject({ status: "accepted", subtotal: 47_000 });
  return cart.body;
}

describe("Cart to Checkout", () => {
  it("carries an accepted quotation forward with the same id, and offers on-account terms", async () => {
    const cart = await acceptedCart();
    const { status, body } = await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [], quote: { proposal: { subtotal: 1 } } });
    expect(status).toBe(201);
    expectValidCheckout(body);
    expect(body.status).toBe("ready_for_complete");
    // The overlapping `quote` on create is ignored (#929 §9; cart/index.md).
    expect(body.quote).toMatchObject({ status: "accepted", id: cart.quote.id, subtotal: 47_000 });
    expect(totalOf(body, "quote")).toBe(-1_000);
    expect(totalOf(body, "total")).toBe(47_000);
    expect(body.payment.selected_term_id).toBe("net_30");
    expect(body.payment.terms.map((t: { id: string }) => t.id)).toEqual(["net_30", "net_60"]);
    const selected = body.payment.terms.find((t: { id: string }) => t.id === "net_30");
    expect(selected.schedules.reduce((s: number, x: { amount: number }) => s + x.amount, 0)).toBe(totalOf(body, "total"));
    expect(body.ucp.payment_handlers).toEqual({});
  });

  it("returns the open Checkout when the same Cart is converted again", async () => {
    const cart = await acceptedCart();
    const first = await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] });
    const second = await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("reflects Checkout changes back to the Cart while they are linked", async () => {
    const cart = await acceptedCart();
    const co = (await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] })).body;
    const changed = await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(20) });
    expect(changed.body.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
    const after = (await call("GET", `/ucp/carts/${cart.id}`)).body;
    expect(after.line_items[0].quantity).toBe(20);
    expect(after.quote).toEqual({});
  });

  it("doesn't let another account convert or read it", async () => {
    const cart = await acceptedCart();
    expect((await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] }, NORTHWIND)).status).toBe(404);
    const co = (await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] })).body;
    expect((await call("GET", `/ucp/checkout-sessions/${co.id}`, undefined, NORTHWIND)).status).toBe(404);
  });
});

describe("payment terms", () => {
  it("selecting Net 60 adds its fee as its own totals entry, and the term sums to the total", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    const { body } = await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(10), payment: { selected_term_id: "net_60" } });
    expectValidCheckout(body);
    expect(body.payment.selected_term_id).toBe("net_60");
    expect(totalOf(body, "fee")).toBe(720);
    expect(totalOf(body, "total")).toBe(48_720);
    const term = body.payment.terms.find((t: { id: string }) => t.id === "net_60");
    expect(term.schedules[0].amount).toBe(48_720);
    // The Buyer asked for this change, so it isn't reported as one.
    expect(body.messages ?? []).not.toContainEqual(expect.objectContaining({ code: "payment_term_changed" }));
  });

  it("keeps the selection and reports payment_term_changed for a term that isn't offered", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    const { body } = await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(10), payment: { selected_term_id: "net_90" } });
    expect(body.payment.selected_term_id).toBe("net_30");
    expect(body.messages).toContainEqual(expect.objectContaining({ code: "payment_term_changed" }));
  });

  it("reports payment_term_changed when accepting a quotation re-sums the selected term (#929 §8)", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    const quoted = (await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(10), quote: { proposal: {} } })).body;
    expect(quoted.quote.status).toBe("quoted");
    unit = 5000; // a rise: the quotation holds, so accepting it lowers the total
    const raised = (await call("GET", `/ucp/checkout-sessions/${co.id}`)).body;
    expect(totalOf(raised, "total")).toBe(50_000);
    const accepted = (await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(10), quote: { accepted_id: quoted.quote.id } })).body;
    expectValidCheckout(accepted);
    expect(totalOf(accepted, "total")).toBe(48_000);
    expect(accepted.messages).toContainEqual(expect.objectContaining({ code: "payment_term_changed" }));
  });
});

describe("Complete Checkout and the Order", () => {
  it("places an Order carrying only the accepted quotation's id and subtotal, and the accepted term", async () => {
    const cart = await acceptedCart();
    const co = (await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] })).body;
    const done = await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: {} });
    expect(done.status).toBe(200);
    expectValidCheckout(done.body);
    expect(done.body.status).toBe("completed");
    expect(done.body.order.id).toMatch(/^ord_/);

    const order = await call("GET", `/ucp/orders/${done.body.order.id}`);
    expect(order.status).toBe(200);
    expectValidOrder(order.body);
    expect(order.body.quote).toEqual({ id: cart.quote.id, subtotal: 47_000 });
    expect(order.body.checkout_id).toBe(co.id);
    const term = order.body.payment.accepted_term;
    expect(term.id).toBe("net_30");
    expect(term.schedules[0].due_at).toBe("2026-12-25T12:00:00.000Z");
    expect(term.schedules.reduce((s: number, x: { amount: number }) => s + x.amount, 0)).toBe(totalOf(order.body, "total"));
    expect((await call("GET", `/ucp/orders/${done.body.order.id}`, undefined, NORTHWIND)).status).toBe(404);
  });

  it("leaves a completed Checkout immutable and clears the Cart", async () => {
    const cart = await acceptedCart();
    const co = (await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] })).body;
    const done = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: {} })).body;
    unit = 1; // later price changes don't touch the record
    expect((await call("GET", `/ucp/checkout-sessions/${co.id}`)).body).toEqual(done);
    expect((await call("PUT", `/ucp/checkout-sessions/${co.id}`, { line_items: lines(1) })).status).toBe(409);
    expect((await call("POST", `/ucp/checkout-sessions/${co.id}/cancel`)).status).toBe(409);
    expect((await call("GET", `/ucp/carts/${cart.id}`)).status).toBe(404);
  });

  it("completing while quoted closes the cycle without an Order quote (#929 §8)", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10), quote: { proposal: {} } })).body;
    expect(co.quote.status).toBe("quoted");
    const done = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: {} })).body;
    expect(done.status).toBe("completed");
    const order = (await call("GET", `/ucp/orders/${done.order.id}`)).body;
    expect(order.quote).toBeUndefined();
    expect(totalOf(order, "total")).toBe(48_000);
  });

  it("doesn't complete over a price change the Buyer hasn't seen; the next complete does", async () => {
    const cart = await acceptedCart();
    const co = (await call("POST", "/ucp/checkout-sessions", { cart_id: cart.id, line_items: [] })).body;
    unit = 4500; // below both the quotation and the list price at issue
    const refused = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: {} })).body;
    expect(refused.status).toBe("ready_for_complete");
    expect(refused.order).toBeUndefined();
    expect(refused.quote.status).toBe("quoted");
    expect(totalOf(refused, "total")).toBe(45_000);
    expect(refused.messages).toContainEqual(expect.objectContaining({ code: "quote_changed" }));
    expect(refused.messages).toContainEqual(expect.objectContaining({ code: "payment_term_changed" }));

    const done = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: {} })).body;
    expect(done.status).toBe("completed");
    const order = (await call("GET", `/ucp/orders/${done.order.id}`)).body;
    expect(totalOf(order, "total")).toBe(45_000);
    // The re-issued quotation was never accepted, so the Order carries none.
    expect(order.quote).toBeUndefined();
  });

  it("requires payment on complete", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    expect((await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, {})).status).toBe(400);
  });

  it("doesn't place an order on account when the Platform sends a payment instrument", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    const card = { id: "instr_1", handler_id: "card_x", type: "card", selected: true, credential: { type: "ap2_payment_mandate", token: "x.y.z" } };
    const refused = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: { instruments: [card] } })).body;
    expect(refused.status).toBe("ready_for_complete");
    expect(refused.order).toBeUndefined();
    expect(refused.messages).toContainEqual(expect.objectContaining({ code: "payment_failed", path: "$.payment.instruments" }));
    expectValidCheckout(refused);
    const done = (await call("POST", `/ucp/checkout-sessions/${co.id}/complete`, { payment: { instruments: [] } })).body;
    expect(done.status).toBe("completed");
  });
});

describe("Checkout without a buyer account", () => {
  it("escalates to the storefront, since there are no terms or handlers to pay with", async () => {
    const { status, body } = await call("POST", "/ucp/checkout-sessions", { line_items: lines(2) }, AGENT);
    expect(status).toBe(201);
    expectValid(schemas.validateAbsolute("https://ucp.dev/schemas/shopping/checkout.json", body));
    expect(body.status).toBe("requires_escalation");
    expect(body.continue_url).toBe(`https://supplier.example/checkout/${body.id}`);
    expect(body.messages).toContainEqual(expect.objectContaining({ severity: "requires_buyer_input" }));
    expect(body.payment).toBeUndefined();
    const attempt = (await call("POST", `/ucp/checkout-sessions/${body.id}/complete`, { payment: {} }, AGENT)).body;
    expect(attempt.status).toBe("requires_escalation");
    expect(attempt.order).toBeUndefined();
  });
});

describe("Cancel Checkout", () => {
  it("cancels an open Checkout", async () => {
    const co = (await call("POST", "/ucp/checkout-sessions", { line_items: lines(10) })).body;
    const { status, body } = await call("POST", `/ucp/checkout-sessions/${co.id}/cancel`);
    expect(status).toBe(200);
    expect(body.status).toBe("canceled");
    expect(body.continue_url).toBeUndefined();
  });
});
