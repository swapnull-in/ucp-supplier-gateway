import { describe, expect, it } from "vitest";
import type { CatalogProduct } from "../src/backend/types.js";
import { lineBinding, priceLines } from "../src/pricing.js";

const usd = (amount: number) => ({ amount, currency: "USD" });

const bolt: CatalogProduct = {
  id: "B1", title: "Bolt", description: "", categories: [],
  price: usd(2000),
  stock: { status: "in_stock", quantity: 1000 },
  orderRules: { minQuantity: 5 },
  priceTiers: [
    { minQuantity: 1, unitPrice: usd(2000) },
    { minQuantity: 100, unitPrice: usd(1900) },
    { minQuantity: 500, unitPrice: usd(1800) },
  ],
};
const glove: CatalogProduct = { id: "G1", title: "Glove", description: "", categories: [], price: usd(4800), stock: { status: "low_stock", quantity: 30 } };
const nut: CatalogProduct = { id: "N1", title: "Nut", description: "", categories: [], price: usd(1275), stock: { status: "out_of_stock" } };
const all = [bolt, glove, nut];

describe("priceLines", () => {
  it("applies the deepest volume break the quantity reaches", () => {
    expect(priceLines([{ itemId: "B1", quantity: 50 }], all).lines[0]!.unitPrice).toEqual(usd(2000));
    const big = priceLines([{ itemId: "B1", quantity: 500 }], all);
    expect(big.lines[0]).toMatchObject({ unitPrice: usd(1800), tierMinQuantity: 500, subtotal: usd(900_000) });
    expect(big.messages).toEqual([expect.objectContaining({ type: "info", code: "volume_price", path: "$.line_items[0]" })]);
  });

  it("totals the lines", () => {
    const p = priceLines([{ itemId: "B1", quantity: 100 }, { itemId: "G1", quantity: 10 }], all);
    expect(p.subtotal).toBe(100 * 1900 + 10 * 4800);
    expect(p.currency).toBe("USD");
  });

  it("flags quantities below the minimum as a recoverable error on that line", () => {
    const p = priceLines([{ itemId: "G1", quantity: 1 }, { itemId: "B1", quantity: 2 }], all);
    expect(p.messages).toContainEqual(expect.objectContaining({ code: "quantity_below_minimum", severity: "recoverable", path: "$.line_items[1].quantity" }));
  });

  it("reports partial and zero stock as backorder warnings", () => {
    const p = priceLines([{ itemId: "G1", quantity: 40 }, { itemId: "N1", quantity: 10 }], all);
    expect(p.lines.map((l) => l.availableQuantity)).toEqual([30, 0]);
    expect(p.messages.map((m) => [m.code, m.path])).toEqual([
      ["insufficient_stock", "$.line_items[0]"],
      ["insufficient_stock", "$.line_items[1]"],
    ]);
  });

  it("drops unknown items and keeps paths aligned to the returned lines", () => {
    const p = priceLines([{ itemId: "NOPE", quantity: 1 }, { itemId: "B1", quantity: 1 }], all);
    expect(p.lines.map((l) => [l.id, l.itemId])).toEqual([["li_1", "B1"]]);
    expect(p.messages.map((m) => [m.code, m.path])).toEqual([
      ["item_unavailable", undefined],
      ["quantity_below_minimum", "$.line_items[0].quantity"],
    ]);
  });

  it("rejects lines priced in a different currency", () => {
    const eur: CatalogProduct = { ...glove, id: "E1", price: { amount: 100, currency: "EUR" } };
    const p = priceLines([{ itemId: "G1", quantity: 1 }, { itemId: "E1", quantity: 1 }], [glove, eur]);
    expect(p.lines).toHaveLength(1);
    expect(p.messages[0]!.code).toBe("currency_mismatch");
  });

  it("binds a quotation to item ids, quantities and currency", () => {
    const a = lineBinding(priceLines([{ itemId: "B1", quantity: 5 }], all));
    expect(lineBinding(priceLines([{ itemId: "B1", quantity: 5 }], all))).toBe(a);
    expect(lineBinding(priceLines([{ itemId: "B1", quantity: 6 }], all))).not.toBe(a);
  });
});
