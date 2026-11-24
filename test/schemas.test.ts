import { describe, expect, it } from "vitest";
import { UcpSchemas } from "../src/ucp/schemas.js";

const schemas = new UcpSchemas();
const envelope = { version: "2026-08-25", capabilities: { "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }] } };
const price = { amount: 100, currency: "USD" };
const product = {
  id: "p1", title: "T", description: { plain: "d" }, price_range: { min: price, max: price },
  variants: [{ id: "v1", title: "T", description: { plain: "d" }, price }],
};

describe("UcpSchemas", () => {
  it("accepts a minimal valid search response", () => {
    expect(schemas.validate("shopping/catalog_search.json#/$defs/search_response", { ucp: envelope, products: [product] }).valid).toBe(true);
  });

  it.each([
    ["missing price_range", { ...product, price_range: undefined }],
    ["fractional amount", { ...product, variants: [{ ...product.variants[0], price: { amount: 1.5, currency: "USD" } }] }],
    ["lowercase currency", { ...product, variants: [{ ...product.variants[0], price: { amount: 1, currency: "usd" } }] }],
    ["empty description", { ...product, description: {} }],
  ])("rejects %s", (_name, bad) => {
    expect(schemas.validate("shopping/catalog_search.json#/$defs/search_response", { ucp: envelope, products: [bad] }).valid).toBe(false);
  });

  it("rejects a bad protocol version", () => {
    expect(schemas.validate("shopping/catalog_search.json#/$defs/search_response", { ucp: { ...envelope, version: "v1" }, products: [] }).valid).toBe(false);
  });

  it("throws on unknown schema refs instead of passing silently", () => {
    expect(() => schemas.validate("shopping/nope.json", {})).toThrow(/Unknown UCP schema/);
  });
});

describe("draft quote extension schema (UCP PR #930)", () => {
  it("validates carts with a quote, including through its refs into the released cart schema", async () => {
    const { DRAFT_QUOTE_ID, loadDraftQuoteSchema } = await import("../src/ucp/quote-schema.js");
    const s = new UcpSchemas();
    s.addSchema(loadDraftQuoteSchema());
    const ref = `${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.cart`;
    const cart = {
      ucp: { version: "2026-08-25" }, id: "cart_1", currency: "USD",
      line_items: [{ id: "li_1", item: { id: "A", title: "A", price: 100 }, quantity: 2, totals: [{ type: "subtotal", amount: 200 }] }],
      totals: [{ type: "subtotal", amount: 200 }, { type: "quote", display_text: "Quoted price adjustment", amount: -10 }, { type: "total", amount: 190 }],
      quote: { status: "accepted", id: "qt_1", subtotal: 190 },
    };
    expect(s.validateAbsolute(ref, cart).valid).toBe(true);
    expect(s.validateAbsolute(ref, { ...cart, quote: { status: "accepted", subtotal: 1.5 } }).valid).toBe(false);
    // totals.json: a non-core entry type like "quote" must carry display_text
    expect(s.validateAbsolute(ref, { ...cart, totals: [cart.totals[0], { type: "quote", amount: -10 }, cart.totals[2]] }).valid).toBe(false);
    // released cart rules still apply: exactly one subtotal and one total
    expect(s.validateAbsolute(ref, { ...cart, totals: [cart.totals[0]] }).valid).toBe(false);
  });
});
