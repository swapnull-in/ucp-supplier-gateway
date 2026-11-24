import type { CatalogProduct, Money } from "./backend/types.js";

/** Unit price for a quantity: the deepest volume break the quantity reaches, else the base price. */
export function unitPriceFor(product: CatalogProduct, quantity: number): { unitPrice: Money; tierMinQuantity?: number } {
  let best: { unitPrice: Money; tierMinQuantity?: number } = { unitPrice: product.price };
  for (const tier of product.priceTiers ?? []) {
    if (quantity >= tier.minQuantity && tier.minQuantity > (best.tierMinQuantity ?? 0)) {
      best = { unitPrice: tier.unitPrice, tierMinQuantity: tier.minQuantity };
    }
  }
  return best;
}

export function multiply(price: Money, quantity: number): Money {
  const amount = price.amount * quantity;
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Line amount out of range: ${price.amount} x ${quantity}`);
  return { amount, currency: price.currency };
}

export interface LineRequest {
  itemId: string;
  quantity: number;
}

export interface PricedLine {
  id: string;
  itemId: string;
  title: string;
  quantity: number;
  unitPrice: Money;
  subtotal: Money;
  tierMinQuantity?: number;
  availableQuantity?: number;
}

export interface PricingMessage {
  type: "error" | "warning" | "info";
  code: string;
  content: string;
  severity?: "recoverable";
  /** RFC 9535 path into the response, e.g. `$.line_items[0].quantity`. */
  path?: string;
}

export interface PricedLines {
  lines: PricedLine[];
  currency: string;
  subtotal: number;
  messages: PricingMessage[];
}

/**
 * Prices requested lines for an account. Pure: no I/O, so pricing rules are testable alone.
 * Unknown or unorderable items are dropped with an error; message paths index the returned lines.
 */
export function priceLines(requests: LineRequest[], products: CatalogProduct[], fallbackCurrency = "USD"): PricedLines {
  const byId = new Map(products.map((p) => [p.id, p]));
  const messages: PricingMessage[] = [];
  const lines: PricedLine[] = [];
  let currency: string | undefined;

  for (const req of requests) {
    const product = byId.get(req.itemId);
    if (!product) {
      messages.push({ type: "error", code: "item_unavailable", severity: "recoverable", content: `Item ${req.itemId} was not found or cannot be ordered` });
      continue;
    }
    currency ??= product.price.currency;
    if (product.price.currency !== currency) {
      messages.push({ type: "error", code: "currency_mismatch", severity: "recoverable", content: `Item ${req.itemId} is priced in ${product.price.currency}, not ${currency}` });
      continue;
    }

    const index = lines.length;
    const path = `$.line_items[${index}]`;
    const { unitPrice, tierMinQuantity } = unitPriceFor(product, req.quantity);
    const line: PricedLine = {
      id: `li_${index + 1}`,
      itemId: product.id,
      title: product.title,
      quantity: req.quantity,
      unitPrice,
      subtotal: multiply(unitPrice, req.quantity),
    };
    if (tierMinQuantity !== undefined && tierMinQuantity > 1) {
      line.tierMinQuantity = tierMinQuantity;
      messages.push({ type: "info", code: "volume_price", path, content: `Volume price for ${tierMinQuantity}+ applied` });
    }

    const minQuantity = product.orderRules?.minQuantity;
    if (minQuantity !== undefined && req.quantity < minQuantity) {
      messages.push({
        type: "error", code: "quantity_below_minimum", severity: "recoverable", path: `${path}.quantity`,
        content: `Minimum order quantity for ${product.id} is ${minQuantity}`,
      });
    }

    const stock = product.stock.quantity ?? (product.stock.status === "out_of_stock" ? 0 : undefined);
    if (stock !== undefined) {
      line.availableQuantity = stock;
      if (stock < req.quantity) {
        messages.push({
          type: "warning", code: "insufficient_stock", path,
          content: stock > 0
            ? `${stock} of ${req.quantity} available now; the rest is on backorder`
            : `${product.id} is out of stock; the full quantity is on backorder`,
        });
      }
    }
    lines.push(line);
  }

  return {
    lines,
    currency: currency ?? fallbackCurrency,
    subtotal: lines.reduce((sum, l) => sum + l.subtotal.amount, 0),
    messages,
  };
}

/** Identity of what a quotation prices: item ids, quantities and currency (UCP #929 §6). */
export function lineBinding(priced: Pick<PricedLines, "lines" | "currency">): string {
  return JSON.stringify([priced.currency, ...priced.lines.map((l) => [l.itemId, l.quantity])]);
}
