import type { FastifyInstance } from "fastify";
import { priceLines } from "../pricing.js";
import { SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ } from "./accounts.js";
import { type CartDeps, type Caller, identify, idempotent, lookupExternal, parseCartBody, quoteContext } from "./cart-routes.js";
import {
  type Checkout,
  type CheckoutStore,
  DEFAULT_TERM_ID,
  type OrderStore,
  TERM_OFFERS,
  paymentTerm,
  priceCheckout,
  toUcpCheckout,
  toUcpOrder,
} from "./checkout.js";
import { errorResponse } from "./catalog.js";
import { type QuoteRequest, advanceQuote } from "./quote.js";

export interface CheckoutDeps extends CartDeps {
  checkouts: CheckoutStore;
  orders: OrderStore;
  storefrontOrigin: string;
  checkoutTtlMs: number;
}

interface CheckoutBody {
  cart_id?: unknown;
  line_items?: unknown;
  quote?: unknown;
  payment?: { selected_term_id?: unknown; instruments?: unknown };
}

/** Changes the Buyer didn't ask for: completing over one would charge a total they haven't seen. */
const UNSEEN_CHANGES = new Set(["quote_changed", "payment_term_changed"]);

export function registerCheckoutRoutes(app: FastifyInstance, base: string, deps: CheckoutDeps) {
  const rendering = { quoteCapability: deps.quoteCapability, storefrontOrigin: deps.storefrontOrigin };

  /** Reprices the Checkout, advances its quote, applies a term selection, saves, and renders it. */
  async function render(checkout: Checkout, caller: Caller, quote?: QuoteRequest, selection?: string) {
    const products = await deps.backend.getProducts(checkout.lines.map((l) => l.itemId), caller.account);
    const priced = priceLines(checkout.lines, products);
    const external = await lookupExternal(deps, quote);
    const step = advanceQuote(checkout.quote, quote, quoteContext(deps, priced, caller, deps.now(), external));
    checkout.quote = step.state;
    const result = priceCheckout(checkout, priced, selection);
    if (checkout.quotable) checkout.reportedTermTotal = result.termTotal;
    await deps.checkouts.save(checkout);
    await syncCart(checkout);
    const messages = [...step.messages];
    return { priced, result, messages, body: toUcpCheckout(checkout, priced, result, messages, rendering) };
  }

  /** While a Cart and its Checkout are linked, the Checkout's lines and quote are reflected back (#929 §9). */
  async function syncCart(checkout: Checkout) {
    if (!checkout.cartId) return;
    const cart = await deps.carts.get(checkout.cartId);
    if (!cart) return;
    cart.lines = checkout.lines;
    cart.quote = checkout.quote;
    await deps.carts.save(cart);
  }

  async function ownCheckout(id: string, owner: string): Promise<Checkout | undefined> {
    const checkout = await deps.checkouts.get(id);
    if (!checkout || checkout.owner !== owner) return undefined;
    if (checkout.state === "open" && deps.now() >= checkout.expiresAt) return undefined;
    return checkout;
  }

  app.post<{ Body: CheckoutBody }>(`${base}/checkout-sessions`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_CHECKOUT_MANAGE);
    if (!caller) return reply;
    const cartId = req.body?.cart_id;
    if (cartId !== undefined && (typeof cartId !== "string" || cartId.length === 0)) {
      return reply.code(400).send(errorResponse("invalid_request", "cart_id must be a string"));
    }
    // With cart_id the Cart's contents are used and overlapping fields are ignored (cart/index.md).
    const input = cartId === undefined ? parseCartBody(req.body, caller.account !== undefined) : undefined;
    if (input && "error" in input) return reply.code(400).send(errorResponse("invalid_request", input.error));

    return idempotent(req, reply, deps, `${caller.owner}|checkout.create`, async () => {
      const now = deps.now();
      const fresh = { state: "open" as const, selectedTermId: DEFAULT_TERM_ID, createdAt: now, expiresAt: new Date(now.getTime() + deps.checkoutTtlMs) };
      if (cartId !== undefined) {
        const cart = await deps.carts.get(cartId);
        if (!cart || cart.owner !== caller.owner || now >= cart.expiresAt) return { statusCode: 404, body: errorResponse("not_found", "Cart not found") };
        // One open Checkout per Cart: converting again returns it.
        const existing = await deps.checkouts.openForCart(cart.id);
        if (existing && now < existing.expiresAt) return { statusCode: 200, body: (await render(existing, caller)).body };
        const checkout = await deps.checkouts.create({ ...fresh, owner: caller.owner, quotable: cart.quotable, cartId: cart.id, lines: cart.lines, quote: cart.quote });
        return { statusCode: 201, body: (await render(checkout, caller)).body };
      }
      const { lines, quote } = input as { lines: Checkout["lines"]; quote?: QuoteRequest };
      const checkout = await deps.checkouts.create({ ...fresh, owner: caller.owner, quotable: caller.account !== undefined, lines, quote: {} });
      return { statusCode: 201, body: (await render(checkout, caller, quote)).body };
    });
  });

  app.get<{ Params: { id: string } }>(`${base}/checkout-sessions/:id`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_CHECKOUT_MANAGE);
    if (!caller) return reply;
    const checkout = await ownCheckout(req.params.id, caller.owner);
    if (!checkout) return reply.code(404).send(errorResponse("not_found", "Checkout not found"));
    if (checkout.final) return checkout.final;
    return (await render(checkout, caller)).body;
  });

  app.put<{ Params: { id: string }; Body: CheckoutBody }>(`${base}/checkout-sessions/:id`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_CHECKOUT_MANAGE);
    if (!caller) return reply;
    const input = parseCartBody(req.body, caller.account !== undefined);
    if ("error" in input) return reply.code(400).send(errorResponse("invalid_request", input.error));
    const selection = req.body?.payment?.selected_term_id;
    if (selection !== undefined && typeof selection !== "string") {
      return reply.code(400).send(errorResponse("invalid_request", "payment.selected_term_id must be a string"));
    }

    return idempotent(req, reply, deps, `${caller.owner}|checkout.update:${req.params.id}`, async () => {
      const checkout = await ownCheckout(req.params.id, caller.owner);
      if (!checkout) return { statusCode: 404, body: errorResponse("not_found", "Checkout not found") };
      if (checkout.final) return { statusCode: 409, body: errorResponse("invalid_state", `Checkout is ${checkout.state} and can't be changed`) };
      // Update is a full replacement of the line items (checkout/index.md, Update Checkout).
      checkout.lines = input.lines;
      return { statusCode: 200, body: (await render(checkout, caller, input.quote, selection)).body };
    });
  });

  app.post<{ Params: { id: string }; Body: CheckoutBody }>(`${base}/checkout-sessions/:id/complete`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_CHECKOUT_MANAGE);
    if (!caller) return reply;
    if (typeof req.body?.payment !== "object" || req.body.payment === null) {
      return reply.code(400).send(errorResponse("invalid_request", "payment is required on complete"));
    }
    const instruments = req.body.payment.instruments ?? [];
    if (!Array.isArray(instruments)) return reply.code(400).send(errorResponse("invalid_request", "payment.instruments must be an array"));

    return idempotent(req, reply, deps, `${caller.owner}|checkout.complete:${req.params.id}`, async () => {
      const checkout = await ownCheckout(req.params.id, caller.owner);
      if (!checkout) return { statusCode: 404, body: errorResponse("not_found", "Checkout not found") };
      if (checkout.state === "completed") return { statusCode: 200, body: checkout.final! };
      if (checkout.state === "canceled") return { statusCode: 409, body: errorResponse("invalid_state", "Checkout is canceled") };

      // Reprice first. If that changed what the Buyer pays, return the new state instead of
      // completing, so the order is placed only at a total the Buyer has seen.
      const current = await render(checkout, caller);
      // No payment handlers are offered: orders are paid on account under the selected term. An
      // instrument means the Platform expects to pay some other way, so placing the order would
      // charge the Buyer in a way they didn't authorize.
      if (instruments.length > 0) {
        const unsupported = {
          type: "error", code: "payment_failed", severity: "recoverable", path: "$.payment.instruments",
          content: "This supplier takes no payment instruments: orders are invoiced to the account under the selected payment term. Complete with no instruments to order on account.",
        };
        const messages = [...((current.body.messages as unknown[]) ?? []), unsupported];
        return { statusCode: 200, body: { ...current.body, messages } };
      }
      const unseen =[...current.messages, ...current.result.messages].some((m) => UNSEEN_CHANGES.has(m.code));
      if (current.result.status !== "ready_for_complete" || unseen) return { statusCode: 200, body: current.body };

      const now = deps.now();
      const offer = TERM_OFFERS.find((t) => t.id === checkout.selectedTermId)!;
      const q = checkout.quote;
      const order = await deps.orders.create({
        owner: checkout.owner,
        checkoutId: checkout.id,
        currency: current.priced.currency,
        lines: current.priced.lines,
        totals: current.result.totals,
        // Completing while quoted or pending closes the cycle; only an accepted quotation reaches the Order (#929 §8).
        ...(q.status === "accepted" && q.id && q.subtotal !== undefined ? { quote: { id: q.id, subtotal: q.subtotal } } : {}),
        acceptedTerm: paymentTerm(offer, current.result.base, now),
        createdAt: now,
      });
      checkout.state = "completed";
      checkout.orderId = order.id;
      const done = { ...current.result, status: "completed" as const, messages: [] };
      checkout.final = toUcpCheckout(checkout, current.priced, done, [], rendering);
      await deps.checkouts.save(checkout);
      // The Cart has served its purpose (cart/index.md, Cart lifecycle after conversion).
      if (checkout.cartId) await deps.carts.delete(checkout.cartId);
      return { statusCode: 200, body: checkout.final };
    });
  });

  app.post<{ Params: { id: string } }>(`${base}/checkout-sessions/:id/cancel`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_CHECKOUT_MANAGE);
    if (!caller) return reply;
    return idempotent(req, reply, deps, `${caller.owner}|checkout.cancel:${req.params.id}`, async () => {
      const checkout = await ownCheckout(req.params.id, caller.owner);
      if (!checkout) return { statusCode: 404, body: errorResponse("not_found", "Checkout not found") };
      if (checkout.final) return { statusCode: 409, body: errorResponse("invalid_state", `Checkout is already ${checkout.state}`) };
      const current = await render(checkout, caller);
      checkout.state = "canceled";
      checkout.final = toUcpCheckout(checkout, current.priced, { ...current.result, status: "canceled", messages: [] }, [], rendering);
      await deps.checkouts.save(checkout);
      return { statusCode: 200, body: checkout.final };
    });
  });

  app.get<{ Params: { id: string } }>(`${base}/orders/:id`, async (req, reply) => {
    const caller = await identify(req, reply, deps, SCOPE_ORDER_READ);
    if (!caller) return reply;
    const order = await deps.orders.get(req.params.id);
    if (!order || order.owner !== caller.owner) return reply.code(404).send(errorResponse("not_found", "Order not found"));
    return toUcpOrder(order, rendering);
  });
}
