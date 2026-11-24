import { randomUUID } from "node:crypto";
import type { LineRequest, PricedLines, PricingMessage } from "../pricing.js";
import { type QuoteState, quoteAdjustment, toUcpQuote } from "./quote.js";
import { UCP_VERSION } from "./schemas.js";

export interface Cart {
  id: string;
  /** Buyer account id, or `anon:<platform profile>` for carts without identity linking. */
  owner: string;
  /** Quotes need a known buyer account (identity-gated, per #929's abuse mitigation). */
  quotable: boolean;
  lines: LineRequest[];
  quote: QuoteState;
  createdAt: Date;
  expiresAt: Date;
}

export interface CartStore {
  create(cart: Omit<Cart, "id">): Promise<Cart>;
  get(id: string): Promise<Cart | undefined>;
  save(cart: Cart): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Single-process store for the demo; production needs a shared, durable store (Postgres). */
export class InMemoryCartStore implements CartStore {
  readonly #carts = new Map<string, Cart>();

  async create(cart: Omit<Cart, "id">): Promise<Cart> {
    const created = { ...cart, id: `cart_${randomUUID()}` };
    this.#carts.set(created.id, created);
    return created;
  }

  async get(id: string): Promise<Cart | undefined> {
    return this.#carts.get(id);
  }

  async save(cart: Cart): Promise<void> {
    this.#carts.set(cart.id, cart);
  }

  async delete(id: string): Promise<void> {
    this.#carts.delete(id);
  }
}

/** Builds the UCP cart response, with the quote extension when the cart is quotable. */
export function toUcpCart(cart: Cart, priced: PricedLines, extraMessages: PricingMessage[], quoteCapability: string) {
  const capabilities: Record<string, { version: string }[]> = { "dev.ucp.shopping.cart": [{ version: UCP_VERSION }] };
  if (cart.quotable) capabilities[quoteCapability] = [{ version: UCP_VERSION }];

  const totals: Record<string, unknown>[] = [{ type: "subtotal", amount: priced.subtotal }];
  const adjustment = cart.quotable ? quoteAdjustment(cart.quote, priced.subtotal) : undefined;
  if (adjustment !== undefined) {
    totals.push({ type: "quote", display_text: "Quoted price adjustment", amount: adjustment });
  }
  // Estimate only: tax and shipping are not calculable before checkout.
  totals.push({ type: "total", amount: priced.subtotal + (adjustment ?? 0) });

  const body: Record<string, unknown> = {
    ucp: { version: UCP_VERSION, capabilities },
    id: cart.id,
    line_items: priced.lines.map((l) => ({
      id: l.id,
      item: { id: l.itemId, title: l.title, price: l.unitPrice.amount },
      quantity: l.quantity,
      totals: [{ type: "subtotal", amount: l.subtotal.amount }],
    })),
    currency: priced.currency,
    totals,
    expires_at: cart.expiresAt.toISOString(),
  };
  const messages = [...priced.messages, ...extraMessages];
  if (messages.length) body.messages = messages;
  if (cart.quotable) body.quote = toUcpQuote(cart.quote);
  return body;
}
