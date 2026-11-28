import { randomUUID } from "node:crypto";
import type { PricingMessage } from "../pricing.js";

// The quote extension proposed in UCP #929 (draft schema: PR #930): a `quote` property on Cart
// with an open status vocabulary, Buyer `proposal` / `accepted_id`, and Business authority over
// every price. Implemented here for Cart only; Checkout and Order projection come with checkout.

export type QuoteStatus = "pending" | "quoted" | "accepted" | "declined" | "expired" | "withdrawn";

export interface QuoteProposal {
  subtotal?: number;
  message?: string;
}

export interface QuoteState {
  /** Absent when no cycle is open ("quotable, idle"). */
  status?: QuoteStatus;
  id?: string;
  subtotal?: number;
  expiresAt?: Date;
  message?: string;
  proposal?: QuoteProposal;
  acceptedId?: string;
  /** Line items and currency the quotation (or pending proposal) was made for. */
  binding?: string;
  /** The current subtotal for the bound lines when the quotation was issued (see `repriceDown`). */
  listSubtotal?: number;
  /** A change the Buyer didn't ask for (e.g. a withdrawal), reported once as `quote_changed`. */
  notice?: string;
}

/** A quotation the Business issued outside any cart (sales desk, CPQ, email), accepted by id. */
export interface ExternalQuote {
  id: string;
  accountId: string;
  binding: string;
  subtotal: number;
  /** The account's subtotal for the bound lines when the quotation was issued (see `repriceDown`). */
  listSubtotal: number;
  expiresAt: Date;
}

export interface QuoteRequest {
  proposal?: QuoteProposal;
  accepted_id?: string;
}

export type QuoteDecision =
  | { decision: "quote"; subtotal: number; message?: string }
  | { decision: "accept"; subtotal: number; message?: string }
  | { decision: "review"; message?: string }
  | { decision: "decline"; message?: string }
  /** The Business won't consider this proposal at all (e.g. `{}` from a policy that needs a figure). */
  | { decision: "unavailable"; message: string };

/** How a Business answers a proposal. Rules, a model or a person; the protocol doesn't care. */
export interface QuotePolicy {
  evaluate(input: { proposal: QuoteProposal; currentSubtotal: number; accountId: string }): QuoteDecision;
}

/**
 * Default policy: an empty proposal gets a firm quotation at the current account price (a price
 * lock); proposals within `autoAcceptPct` below it are accepted; within `reviewPct` they wait for
 * a person; anything lower is declined. A proposal above the current price is accepted at the
 * current price, never at the higher one. With `quoteOnEmpty: false`, `{}` is answered with
 * `quote_unavailable` instead, as #929's thread allows for a Business whose answer would reveal
 * its floor.
 */
export class ThresholdQuotePolicy implements QuotePolicy {
  constructor(
    private readonly autoAcceptPct = 0.03,
    private readonly reviewPct = 0.1,
    private readonly quoteOnEmpty = true,
  ) {}

  evaluate({ proposal, currentSubtotal }: { proposal: QuoteProposal; currentSubtotal: number }): QuoteDecision {
    if (proposal.subtotal === undefined) {
      if (!this.quoteOnEmpty) return { decision: "unavailable", message: "Propose a subtotal for these line items to request a quotation." };
      return { decision: "quote", subtotal: currentSubtotal, message: "Firm price for these line items until the quotation expires." };
    }
    if (proposal.subtotal >= currentSubtotal) return { decision: "accept", subtotal: currentSubtotal };
    if (proposal.subtotal >= Math.ceil(currentSubtotal * (1 - this.autoAcceptPct))) {
      return { decision: "accept", subtotal: proposal.subtotal };
    }
    if (proposal.subtotal >= Math.ceil(currentSubtotal * (1 - this.reviewPct))) {
      return { decision: "review", message: "Your proposal is with our sales team for review." };
    }
    return { decision: "decline", message: "We can't offer that price for these line items." };
  }
}

export interface QuoteContext {
  binding: string;
  currentSubtotal: number;
  accountId: string;
  now: Date;
  quotationTtlMs: number;
  policy: QuotePolicy;
  /** Resolves an `accepted_id` the cart didn't issue (an out-of-band quotation), if any. */
  resolveExternal?: (id: string) => ExternalQuote | undefined;
}

const OPEN: ReadonlySet<QuoteStatus | undefined> = new Set(["pending", "quoted", "accepted"]);

const changed = (content: string): PricingMessage => ({ type: "warning", code: "quote_changed", content, path: "$.quote" });

/**
 * Applies time, line-item changes and a Buyer request to the quote state, in that order, then
 * never lets a quotation stand above the current price (see `repriceDown`).
 * Returns the next state and any messages for the response. Never throws for Buyer mistakes:
 * those become `quote_unavailable` or `quote_changed` messages, as #929 specifies.
 */
export function advanceQuote(prev: QuoteState, req: QuoteRequest | undefined, ctx: QuoteContext): { state: QuoteState; messages: PricingMessage[] } {
  const result = applyRequest(prev, req, ctx);
  return repriceDown(result, ctx);
}

/**
 * A quotation the Buyer holds must never cost more than the Business's current price for the same
 * lines once that price falls: holding a price that rose is the point of a quotation, holding one
 * that fell works against the Buyer, and buyer agents measurably accept such quotes (#929,
 * comments 7138134081, 7140972277 and 7151328635). So when the current subtotal is below both the
 * quoted subtotal and the list subtotal at issue, the quotation is re-issued at the current
 * subtotal under a new id (a subtotal never changes for an id, §6) and `quote_changed` is reported.
 * The second condition keeps a quotation set above list on purpose until the price actually falls.
 * A re-issued quotation is always `quoted`, even if the old one was accepted: accepting is the
 * Buyer's act (§1), so the Buyer accepts the new id. The spec doesn't settle this yet.
 */
function repriceDown(result: { state: QuoteState; messages: PricingMessage[] }, ctx: QuoteContext) {
  const { state, messages } = result;
  const holding = state.status === "quoted" || state.status === "accepted";
  if (!holding || state.subtotal === undefined || state.binding !== ctx.binding) return result;
  // Every quotation records its list subtotal at issue; this fallback only covers older state.
  const listSubtotal = state.listSubtotal ?? ctx.currentSubtotal;
  if (ctx.currentSubtotal >= Math.min(state.subtotal, listSubtotal)) return { state: { ...state, listSubtotal }, messages };
  const expiresAt = state.status === "quoted" && state.expiresAt ? state.expiresAt : new Date(ctx.now.getTime() + ctx.quotationTtlMs);
  const next: QuoteState = { ...state, status: "quoted", id: newQuoteId(), subtotal: ctx.currentSubtotal, listSubtotal: ctx.currentSubtotal, expiresAt };
  // The old message and acceptance belonged to the old quotation.
  delete next.acceptedId;
  delete next.message;
  return {
    state: next,
    messages: [...messages, changed(`The current price for these line items fell below quotation ${state.id}, so it was re-issued at the lower price as ${next.id}; accept the new id to apply it.`)],
  };
}

function applyRequest(prev: QuoteState, req: QuoteRequest | undefined, ctx: QuoteContext): { state: QuoteState; messages: PricingMessage[] } {
  const messages: PricingMessage[] = [];
  let state: QuoteState = { ...prev };

  if (state.notice) {
    messages.push(changed(state.notice));
    delete state.notice;
  }

  // A lapsed, unaccepted quotation is expired; an accepted one never lapses.
  if (state.status === "quoted" && state.expiresAt && ctx.now >= state.expiresAt) state.status = "expired";

  // Changing line items or currency invalidates an open cycle (#929 §6).
  if (OPEN.has(state.status) && state.binding !== ctx.binding) {
    messages.push(changed("Line items changed, so the quotation no longer applies."));
    state = {};
  }

  if (!req) return { state, messages };

  if (req.proposal && req.accepted_id) {
    messages.push({ type: "error", code: "quote_unavailable", severity: "recoverable", path: "$.quote", content: "Send either a proposal or an accepted_id, not both." });
    return { state, messages };
  }

  if (req.proposal) {
    const proposal = req.proposal;
    const decision = ctx.policy.evaluate({ proposal, currentSubtotal: ctx.currentSubtotal, accountId: ctx.accountId });
    const base: QuoteState = { proposal, binding: ctx.binding };
    if (decision.message) base.message = decision.message;
    switch (decision.decision) {
      case "quote":
        state = { ...base, status: "quoted", id: newQuoteId(), subtotal: decision.subtotal, listSubtotal: ctx.currentSubtotal, expiresAt: new Date(ctx.now.getTime() + ctx.quotationTtlMs) };
        break;
      case "accept": {
        const id = newQuoteId();
        state = { ...base, status: "accepted", id, subtotal: decision.subtotal, listSubtotal: ctx.currentSubtotal };
        break;
      }
      case "review":
        state = { ...base, status: "pending" };
        break;
      case "decline":
        state = { ...base, status: "declined" };
        break;
      case "unavailable":
        messages.push({ type: "error", code: "quote_unavailable", severity: "recoverable", path: "$.quote", content: decision.message });
        break;
    }
    return { state, messages };
  }

  if (req.accepted_id !== undefined) {
    if (state.status === "accepted" && state.id === req.accepted_id) return { state, messages }; // repeat: no-op
    if (state.status === "quoted" && state.id === req.accepted_id && state.binding === ctx.binding) {
      state = { ...state, status: "accepted", acceptedId: req.accepted_id };
      delete state.proposal;
      return { state, messages };
    }
    // An out-of-band quotation binds by item ids, quantities and currency, not line ids (#929 §4, §6).
    const external = req.accepted_id === state.id ? undefined : ctx.resolveExternal?.(req.accepted_id);
    if (external && external.accountId === ctx.accountId && external.binding === ctx.binding && ctx.now < external.expiresAt) {
      // A stale quotation doesn't displace one the Cart holds at or below today's price: re-issuing
      // it would leave the Buyer worse off than before they accepted (#930 review).
      const stale = ctx.currentSubtotal < Math.min(external.subtotal, external.listSubtotal);
      const held = (state.status === "quoted" || state.status === "accepted") && state.subtotal !== undefined && state.subtotal <= ctx.currentSubtotal;
      if (stale && held) {
        messages.push(changed(`Quotation ${external.id} is above today's price for these line items, so it wasn't applied; quotation ${state.id} still stands.`));
        return { state, messages };
      }
      // Its list subtotal is the one recorded at issue, so a stale quotation is caught on accept (#930 review).
      state = { status: "accepted", id: external.id, subtotal: external.subtotal, listSubtotal: external.listSubtotal, acceptedId: external.id, binding: ctx.binding };
      return { state, messages };
    }
    messages.push(changed(`Quotation ${req.accepted_id} can't be accepted: it is unknown, superseded, expired or for different line items.`));
  }
  return { state, messages };
}

/** Business-side answer to a pending proposal (e.g. from a sales rep's review). */
export function answerPending(
  prev: QuoteState,
  answer: { status: "quoted" | "declined"; subtotal?: number; message?: string },
  now: Date,
  ttlMs: number,
  /** The account's current subtotal for the proposal's lines, recorded as the quotation's list. */
  listSubtotal?: number,
): QuoteState {
  if (prev.status !== "pending") throw new Error(`No pending proposal (status: ${prev.status ?? "idle"})`);
  const next: QuoteState = { ...prev, status: answer.status };
  if (answer.message) next.message = answer.message;
  if (answer.status === "quoted") {
    if (answer.subtotal === undefined) throw new Error("A quotation needs a subtotal");
    next.id = newQuoteId();
    next.subtotal = answer.subtotal;
    if (listSubtotal !== undefined) next.listSubtotal = listSubtotal;
    next.expiresAt = new Date(now.getTime() + ttlMs);
  }
  return next;
}

/** Business-side withdrawal of a quoted or accepted quotation; the id and subtotal are kept (#929 §6). */
export function withdrawQuote(prev: QuoteState): QuoteState {
  if (prev.status !== "quoted" && prev.status !== "accepted") throw new Error(`Nothing to withdraw (status: ${prev.status ?? "idle"})`);
  const next: QuoteState = { ...prev, status: "withdrawn", notice: `The Business withdrew quotation ${prev.id}.` };
  // The cycle is closed, so the Buyer's proposal and acceptance are no longer echoed.
  delete next.proposal;
  delete next.acceptedId;
  return next;
}

/** The signed `quote` totals entry: quoted subtotal minus the line subtotals (#929 §5). */
export function quoteAdjustment(state: QuoteState, linesSubtotal: number): number | undefined {
  return state.status === "accepted" && state.subtotal !== undefined ? state.subtotal - linesSubtotal : undefined;
}

export function toUcpQuote(state: QuoteState): Record<string, unknown> {
  if (!state.status) return {};
  const out: Record<string, unknown> = { status: state.status };
  if (state.id) out.id = state.id;
  if (state.subtotal !== undefined) out.subtotal = state.subtotal;
  if (state.expiresAt && state.status === "quoted") out.expires_at = state.expiresAt.toISOString();
  if (state.message) out.message = state.message;
  // proposal / accepted_id are echoed while the cycle they belong to is open.
  if (state.proposal) out.proposal = state.proposal;
  if (state.acceptedId) out.accepted_id = state.acceptedId;
  return out;
}

function newQuoteId(): string {
  return `qt_${randomUUID()}`;
}
