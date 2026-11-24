import type { CatalogProduct, StockStatus } from "../backend/types.js";
import { UCP_VERSION } from "./schemas.js";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

const AVAILABILITY: Record<StockStatus, { available: boolean; status: string }> = {
  in_stock: { available: true, status: "in_stock" },
  // UCP has no well-known "low stock" status; it is still obtainable now.
  low_stock: { available: true, status: "in_stock" },
  out_of_stock: { available: false, status: "out_of_stock" },
};

/**
 * Maps a canonical product to a UCP catalog product with a single default variant.
 * `inputs` is the lookup correlation for that variant (required in lookup responses).
 */
export function toUcpProduct(p: CatalogProduct, storefrontOrigin: string, inputs?: { id: string; match: string }[]) {
  const url = p.url ? new URL(p.url, storefrontOrigin).toString() : undefined;
  const price = { amount: p.price.amount, currency: p.price.currency };
  const variant: Record<string, unknown> = {
    id: p.id,
    sku: p.id,
    title: p.title,
    description: { plain: p.description },
    price,
    availability: AVAILABILITY[p.stock.status],
  };
  if (p.listPrice) variant.list_price = p.listPrice;
  if (url) variant.url = url;
  if (inputs) variant.inputs = inputs;

  const product: Record<string, unknown> = {
    id: p.id,
    title: p.title,
    description: { plain: p.description },
    categories: p.categories.map((value) => ({ value, taxonomy: "merchant" })),
    price_range: { min: price, max: price },
    variants: [variant],
  };
  if (url) product.url = url;
  return product;
}

export function catalogResponse(capability: string, products: Record<string, unknown>[], accountPriced: boolean) {
  const response: Record<string, unknown> = {
    ucp: {
      version: UCP_VERSION,
      capabilities: { [capability]: [{ version: UCP_VERSION }] },
    },
    products,
  };
  if (accountPriced) {
    response.messages = [
      { type: "info", code: "account_pricing", content: "Prices reflect the linked buyer account's contract." },
    ];
  }
  return response;
}

export function errorResponse(code: string, content: string) {
  return {
    ucp: { version: UCP_VERSION, status: "error" },
    messages: [{ type: "error", code, content, severity: "unrecoverable" }],
  };
}
