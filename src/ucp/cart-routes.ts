import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BuyerAccount, CommerceBackend } from "../backend/types.js";
import { authenticate, requirePlatform } from "../http.js";
import { type IdempotencyStore, fingerprint } from "../idempotency.js";
import { type LineRequest, lineBinding, priceLines } from "../pricing.js";
import { type AccountResolver, SCOPE_CART_MANAGE } from "./accounts.js";
import { type Cart, type CartStore, toUcpCart } from "./cart.js";
import { errorResponse } from "./catalog.js";
import { type ExternalQuote, type QuotePolicy, type QuoteRequest, advanceQuote, answerPending, withdrawQuote } from "./quote.js";
import type { QuoteBook } from "./quote-book.js";

export interface CartDeps {
  backend: CommerceBackend;
  accounts: AccountResolver;
  carts: CartStore;
  idempotency: IdempotencyStore;
  quotePolicy: QuotePolicy;
  /** Quotations issued outside carts, acceptable on a cart by id. */
  quoteBook: QuoteBook;
  quoteCapability: string;
  cartTtlMs: number;
  quotationTtlMs: number;
  now: () => Date;
  /** Enables the Business-side admin routes (answer, withdraw, issue quotations) when set. */
  adminToken?: string;
}

interface CartBody {
  line_items?: unknown;
  quote?: unknown;
}

const MAX_LINES = 100;

export function registerCartRoutes(app: FastifyInstance, base: string, deps: CartDeps) {
  app.post<{ Body: CartBody }>(`${base}/carts`, async (req, reply) => {
    const caller = await identify(req, reply, deps);
    if (!caller) return reply;
    const input = parseCartBody(req.body, caller.account !== undefined);
    if ("error" in input) return reply.code(400).send(errorResponse("invalid_request", input.error));

    return idempotent(req, reply, deps, `${caller.owner}|cart.create`, async () => {
      const products = await deps.backend.getProducts(input.lines.map((l) => l.itemId), caller.account);
      const priced = priceLines(input.lines, products);
      if (priced.lines.length === 0) {
        // All requested items are unavailable: no cart is created (cart/index.md, Create Cart).
        const body = errorResponse("item_unavailable", "None of the requested items can be ordered");
        return { statusCode: 200, body: { ...body, messages: [...body.messages, ...priced.messages] } };
      }
      const now = deps.now();
      const cart = await deps.carts.create({
        owner: caller.owner,
        quotable: caller.account !== undefined,
        lines: input.lines,
        quote: {},
        createdAt: now,
        expiresAt: new Date(now.getTime() + deps.cartTtlMs),
      });
      const external = await lookupExternal(deps, input.quote);
      const step = advanceQuote(cart.quote, input.quote, quoteContext(deps, priced, caller, now, external));
      cart.quote = step.state;
      await deps.carts.save(cart);
      return { statusCode: 201, body: toUcpCart(cart, priced, step.messages, deps.quoteCapability) };
    });
  });

  app.get<{ Params: { id: string } }>(`${base}/carts/:id`, async (req, reply) => {
    const caller = await identify(req, reply, deps);
    if (!caller) return reply;
    const cart = await ownCart(req.params.id, caller.owner, deps);
    if (!cart) return reply.code(404).send(errorResponse("not_found", "Cart not found"));

    // Prices are re-read on every Get, so the cart reflects current account pricing and stock.
    const products = await deps.backend.getProducts(cart.lines.map((l) => l.itemId), caller.account);
    const priced = priceLines(cart.lines, products);
    const step = advanceQuote(cart.quote, undefined, quoteContext(deps, priced, caller, deps.now()));
    cart.quote = step.state;
    await deps.carts.save(cart);
    return toUcpCart(cart, priced, step.messages, deps.quoteCapability);
  });

  app.put<{ Params: { id: string }; Body: CartBody }>(`${base}/carts/:id`, async (req, reply) => {
    const caller = await identify(req, reply, deps);
    if (!caller) return reply;
    const input = parseCartBody(req.body, caller.account !== undefined);
    if ("error" in input) return reply.code(400).send(errorResponse("invalid_request", input.error));

    return idempotent(req, reply, deps, `${caller.owner}|cart.update:${req.params.id}`, async () => {
      const cart = await ownCart(req.params.id, caller.owner, deps);
      if (!cart) return { statusCode: 404, body: errorResponse("not_found", "Cart not found") };
      // Update is a full replacement of the line items (cart/index.md, Update Cart).
      const products = await deps.backend.getProducts(input.lines.map((l) => l.itemId), caller.account);
      const priced = priceLines(input.lines, products);
      cart.lines = input.lines;
      const external = await lookupExternal(deps, input.quote);
      const step = advanceQuote(cart.quote, input.quote, quoteContext(deps, priced, caller, deps.now(), external));
      cart.quote = step.state;
      await deps.carts.save(cart);
      return { statusCode: 200, body: toUcpCart(cart, priced, step.messages, deps.quoteCapability) };
    });
  });

  app.post<{ Params: { id: string } }>(`${base}/carts/:id/cancel`, async (req, reply) => {
    const caller = await identify(req, reply, deps);
    if (!caller) return reply;
    return idempotent(req, reply, deps, `${caller.owner}|cart.cancel:${req.params.id}`, async () => {
      const cart = await ownCart(req.params.id, caller.owner, deps);
      if (!cart) return { statusCode: 404, body: errorResponse("not_found", "Cart not found") };
      // Cancel returns the cart state before deletion (cart/index.md, Cancel Cart).
      const products = await deps.backend.getProducts(cart.lines.map((l) => l.itemId), caller.account);
      const body = toUcpCart(cart, priceLines(cart.lines, products), [], deps.quoteCapability);
      await deps.carts.delete(cart.id);
      return { statusCode: 200, body };
    });
  });

  if (deps.adminToken) {
    // Business-side answer to a pending proposal (quoted / declined), or withdrawal of a quoted or
    // accepted quotation, standing in for a sales rep's review queue.
    app.post<{ Params: { id: string }; Body: { status?: unknown; subtotal?: unknown; message?: unknown } }>(
      `/admin/carts/:id/quote`,
      async (req, reply) => {
        if (req.headers["x-admin-token"] !== deps.adminToken) return reply.code(401).send(errorResponse("unauthorized", "Admin token required"));
        const cart = await deps.carts.get(req.params.id);
        if (!cart) return reply.code(404).send(errorResponse("not_found", "Cart not found"));
        const { status, subtotal, message } = req.body ?? {};
        if ((status !== "quoted" && status !== "declined" && status !== "withdrawn") || (subtotal !== undefined && !isAmount(subtotal))) {
          return reply.code(400).send(errorResponse("invalid_request", 'status must be "quoted" (with subtotal), "declined" or "withdrawn"'));
        }
        try {
          if (status === "withdrawn") {
            cart.quote = withdrawQuote(cart.quote);
            await deps.carts.save(cart);
            return { id: cart.id, quote: cart.quote.status };
          }
          const answer: { status: "quoted" | "declined"; subtotal?: number; message?: string } = { status };
          if (subtotal !== undefined) answer.subtotal = subtotal as number;
          if (typeof message === "string") answer.message = message;
          cart.quote = answerPending(cart.quote, answer, deps.now(), deps.quotationTtlMs);
        } catch (err) {
          return reply.code(409).send(errorResponse("invalid_state", (err as Error).message));
        }
        await deps.carts.save(cart);
        return { id: cart.id, quote: cart.quote.status };
      },
    );

    // A quotation issued outside any cart (sales desk, CPQ, email) to a buyer account. The Buyer
    // accepts it on a cart holding the same items and quantities, by `quote.accepted_id`.
    app.post<{ Body: { account_id?: unknown; currency?: unknown; subtotal?: unknown; line_items?: unknown; expires_in_hours?: unknown } }>(
      `/admin/quotes`,
      async (req, reply) => {
        if (req.headers["x-admin-token"] !== deps.adminToken) return reply.code(401).send(errorResponse("unauthorized", "Admin token required"));
        const { account_id, currency, subtotal, expires_in_hours } = req.body ?? {};
        const parsed = parseCartBody({ line_items: req.body?.line_items }, false);
        if ("error" in parsed) return reply.code(400).send(errorResponse("invalid_request", parsed.error));
        if (typeof account_id !== "string" || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency) || !isAmount(subtotal)) {
          return reply.code(400).send(errorResponse("invalid_request", "account_id, currency (ISO 4217) and subtotal (minor units) are required"));
        }
        const hours = typeof expires_in_hours === "number" && expires_in_hours > 0 ? expires_in_hours : deps.quotationTtlMs / 3600_000;
        const quote = await deps.quoteBook.issue({
          accountId: account_id,
          binding: lineBinding({ currency, lines: parsed.lines }),
          subtotal: subtotal as number,
          expiresAt: new Date(deps.now().getTime() + hours * 3600_000),
        });
        return reply.code(201).send({ id: quote.id, subtotal: quote.subtotal, expires_at: quote.expiresAt.toISOString() });
      },
    );
  }
}

/** Fetches the out-of-band quotation an `accepted_id` names, so the pure state machine can bind it. */
export async function lookupExternal(deps: Pick<CartDeps, "quoteBook">, quote: QuoteRequest | undefined): Promise<ExternalQuote | undefined> {
  return quote?.accepted_id ? deps.quoteBook.get(quote.accepted_id) : undefined;
}

export interface Caller {
  owner: string;
  account?: BuyerAccount;
}

export async function identify(req: FastifyRequest, reply: FastifyReply, deps: Pick<CartDeps, "accounts">, scope = SCOPE_CART_MANAGE): Promise<Caller | undefined> {
  const platform = requirePlatform(req, reply);
  if (!platform) return undefined;
  const auth = await authenticate(req, reply, deps.accounts, scope);
  if (!auth.ok) return undefined;
  return auth.account ? { owner: `acct:${auth.account.id}`, account: auth.account } : { owner: `anon:${platform.href}` };
}

/** Another owner's or an expired cart is reported as not found, so cart ids can't be probed. */
async function ownCart(id: string, owner: string, deps: CartDeps): Promise<Cart | undefined> {
  const cart = await deps.carts.get(id);
  if (!cart || cart.owner !== owner) return undefined;
  if (deps.now() >= cart.expiresAt) {
    await deps.carts.delete(id);
    return undefined;
  }
  return cart;
}

export function quoteContext(deps: Pick<CartDeps, "quotationTtlMs" | "quotePolicy">, priced: ReturnType<typeof priceLines>, caller: Caller, now: Date, external?: ExternalQuote) {
  return {
    resolveExternal: (id: string) => (external?.id === id ? external : undefined),
    binding: lineBinding(priced),
    currentSubtotal: priced.subtotal,
    accountId: caller.account?.id ?? caller.owner,
    now,
    quotationTtlMs: deps.quotationTtlMs,
    policy: deps.quotePolicy,
  };
}

/**
 * Cart operations SHOULD support idempotency, and MUST honour a provided key (cart/rest.md).
 * Without a key the operation simply runs.
 */
export async function idempotent(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<CartDeps, "idempotency">,
  scope: string,
  run: () => Promise<{ statusCode: number; body: unknown }>,
) {
  const key = req.headers["idempotency-key"];
  if (key === undefined) {
    const { statusCode, body } = await runSafely(req, run);
    return reply.code(statusCode).send(body);
  }
  if (typeof key !== "string" || key.length === 0 || key.length > 255) {
    return reply.code(400).send(errorResponse("invalid_request", "Idempotency-Key must be 1-255 characters"));
  }
  const claim = await deps.idempotency.begin(scope, key, fingerprint(req.rawBody ?? ""));
  if (claim.state === "conflict") {
    return reply.code(409).send(errorResponse("idempotency_conflict", "Idempotency-Key was already used with a different request body"));
  }
  if (claim.state === "in_flight") {
    return reply.code(409).header("retry-after", "1").send(errorResponse("idempotency_in_flight", "A request with this Idempotency-Key is still being processed"));
  }
  if (claim.state === "replay") return reply.code(claim.statusCode).header("idempotent-replayed", "true").send(claim.body);

  const result = await runSafely(req, run);
  // Server errors aren't stored, so the same key can be retried once the backend recovers.
  if (result.statusCode >= 500) await deps.idempotency.release(scope, key);
  else await deps.idempotency.complete(scope, key, result.statusCode, result.body);
  return reply.code(result.statusCode).send(result.body);
}

async function runSafely(req: FastifyRequest, run: () => Promise<{ statusCode: number; body: unknown }>) {
  try {
    return await run();
  } catch (err) {
    req.log.error({ err }, "operation failed");
    return { statusCode: 500, body: errorResponse("backend_unavailable", "Temporarily unavailable; retry shortly") };
  }
}

type ParsedCart = { lines: LineRequest[]; quote?: QuoteRequest } | { error: string };

export function parseCartBody(body: CartBody | undefined, quotable: boolean): ParsedCart {
  const raw = body?.line_items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINES) {
    return { error: `line_items must be an array of 1-${MAX_LINES} items` };
  }
  const lines: LineRequest[] = [];
  for (const [i, li] of raw.entries()) {
    const id = (li as { item?: { id?: unknown } })?.item?.id;
    const quantity = (li as { quantity?: unknown })?.quantity;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return { error: `line_items[${i}].item.id must be a non-empty string` };
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
      return { error: `line_items[${i}].quantity must be an integer from 1 to 1000000` };
    }
    lines.push({ itemId: id, quantity });
  }
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) return { error: "Each item may appear only once; combine quantities" };

  if (body?.quote === undefined) return { lines };
  if (!quotable) return { error: "Quotes need a linked buyer account (identity linking)" };
  const q = body.quote as { proposal?: unknown; accepted_id?: unknown };
  if (typeof q !== "object" || q === null) return { error: "quote must be an object" };
  const quote: QuoteRequest = {};
  if (q.proposal !== undefined) {
    const p = q.proposal as { subtotal?: unknown; message?: unknown };
    if (typeof p !== "object" || p === null) return { error: "quote.proposal must be an object" };
    if (p.subtotal !== undefined && !isAmount(p.subtotal)) return { error: "quote.proposal.subtotal must be a non-negative integer in minor units" };
    if (p.message !== undefined && (typeof p.message !== "string" || p.message.length > 2000)) return { error: "quote.proposal.message must be a string" };
    quote.proposal = {};
    if (p.subtotal !== undefined) quote.proposal.subtotal = p.subtotal as number;
    if (p.message !== undefined) quote.proposal.message = p.message as string;
  }
  if (q.accepted_id !== undefined) {
    if (typeof q.accepted_id !== "string" || q.accepted_id.length === 0) return { error: "quote.accepted_id must be a string" };
    quote.accepted_id = q.accepted_id;
  }
  return { lines, quote };
}

export function isAmount(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
