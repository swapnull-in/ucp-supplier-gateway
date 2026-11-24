import { describe, expect, it } from "vitest";
import { type ExternalQuote, type QuoteContext, type QuoteState, ThresholdQuotePolicy, advanceQuote, answerPending, quoteAdjustment, toUcpQuote, withdrawQuote } from "../src/ucp/quote.js";

// Transitions from the UCP #929 lifecycle table, for a Cart.

const T0 = new Date("2026-11-24T12:00:00Z");
const DAY = 24 * 3600_000;
const ctx = (over: Partial<QuoteContext> = {}): QuoteContext => ({
  binding: "lines-A",
  currentSubtotal: 100_000,
  accountId: "acme",
  now: T0,
  quotationTtlMs: 7 * DAY,
  policy: new ThresholdQuotePolicy(0.03, 0.1),
  ...over,
});

const propose = (subtotal?: number, state: QuoteState = {}, c = ctx()) =>
  advanceQuote(state, { proposal: subtotal === undefined ? {} : { subtotal } }, c);

describe("proposals (default policy: auto-accept within 3%, review within 10%)", () => {
  it("an empty proposal gets a firm quotation at the current price, with an id and expiry", () => {
    const { state, messages } = propose();
    expect(state).toMatchObject({ status: "quoted", subtotal: 100_000, binding: "lines-A" });
    expect(state.id).toMatch(/^qt_/);
    expect(state.expiresAt).toEqual(new Date(T0.getTime() + 7 * DAY));
    expect(messages).toEqual([]);
  });

  it("accepts outright within the auto-accept band, with no accepted_id", () => {
    const { state } = propose(97_500);
    expect(state).toMatchObject({ status: "accepted", subtotal: 97_500 });
    expect(state.acceptedId).toBeUndefined();
    expect(quoteAdjustment(state, 100_000)).toBe(-2_500);
  });

  it("never charges more than the current price when the proposal is higher", () => {
    expect(propose(120_000).state).toMatchObject({ status: "accepted", subtotal: 100_000 });
  });

  it("holds proposals in the review band as pending, and declines below it", () => {
    expect(propose(92_000).state.status).toBe("pending");
    expect(propose(80_000).state.status).toBe("declined");
    expect(propose(80_000).state.id).toBeUndefined();
  });

  it("a new proposal supersedes an unaccepted quotation silently", () => {
    const first = propose().state;
    const { state, messages } = propose(99_000, first);
    expect(state.id).not.toBe(first.id);
    expect(messages).toEqual([]);
  });

  it("rejects a request carrying both proposal and accepted_id, leaving state unchanged", () => {
    const first = propose().state;
    const { state, messages } = advanceQuote(first, { proposal: {}, accepted_id: first.id! }, ctx());
    expect(state).toEqual(first);
    expect(messages).toEqual([expect.objectContaining({ type: "error", code: "quote_unavailable", severity: "recoverable" })]);
  });
});

describe("acceptance", () => {
  it("accepts the current quotation by id and echoes accepted_id", () => {
    const quoted = propose().state;
    const { state } = advanceQuote(quoted, { accepted_id: quoted.id! }, ctx());
    expect(state).toMatchObject({ status: "accepted", id: quoted.id, acceptedId: quoted.id });
    expect(toUcpQuote(state)).toMatchObject({ status: "accepted", accepted_id: quoted.id, subtotal: 100_000 });
  });

  it("repeating the current accepted_id is a no-op", () => {
    const quoted = propose().state;
    const accepted = advanceQuote(quoted, { accepted_id: quoted.id! }, ctx()).state;
    const again = advanceQuote(accepted, { accepted_id: quoted.id! }, ctx());
    expect(again.state).toEqual(accepted);
    expect(again.messages).toEqual([]);
  });

  it("an unknown or superseded id fails closed with quote_changed", () => {
    const quoted = propose().state;
    const { state, messages } = advanceQuote(quoted, { accepted_id: "qt_other" }, ctx());
    expect(state).toEqual(quoted);
    expect(messages[0]).toMatchObject({ type: "warning", code: "quote_changed" });
  });

  it("an unaccepted quotation expires; acceptance after expiry fails closed", () => {
    const quoted = propose().state;
    const later = ctx({ now: new Date(T0.getTime() + 8 * DAY) });
    expect(advanceQuote(quoted, undefined, later).state.status).toBe("expired");
    const late = advanceQuote(quoted, { accepted_id: quoted.id! }, later);
    expect(late.state).toMatchObject({ status: "expired", id: quoted.id });
    expect(late.messages[0]!.code).toBe("quote_changed");
  });

  it("an accepted quotation never lapses", () => {
    const quoted = propose().state;
    const accepted = advanceQuote(quoted, { accepted_id: quoted.id! }, ctx()).state;
    expect(advanceQuote(accepted, undefined, ctx({ now: new Date(T0.getTime() + 30 * DAY) })).state.status).toBe("accepted");
  });
});

describe("invalidation and review", () => {
  it("changing line items invalidates an accepted quotation and removes the totals entry", () => {
    const accepted = propose(98_000).state;
    const { state, messages } = advanceQuote(accepted, undefined, ctx({ binding: "lines-B" }));
    expect(state).toEqual({});
    expect(quoteAdjustment(state, 100_000)).toBeUndefined();
    expect(messages[0]).toMatchObject({ code: "quote_changed", path: "$.quote" });
    expect(toUcpQuote(state)).toEqual({});
  });

  it("a Business answers a pending proposal with a quotation or a decline", () => {
    const pending = propose(92_000).state;
    const quoted = answerPending(pending, { status: "quoted", subtotal: 94_000, message: "Best we can do." }, T0, DAY);
    expect(quoted).toMatchObject({ status: "quoted", subtotal: 94_000, message: "Best we can do." });
    expect(quoted.id).toMatch(/^qt_/);
    expect(answerPending(pending, { status: "declined" }, T0, DAY).status).toBe("declined");
    expect(() => answerPending({}, { status: "declined" }, T0, DAY)).toThrow(/No pending proposal/);
  });
});

describe("withdrawal (Business revokes a quotation)", () => {
  it("keeps id and subtotal, removes the totals entry, and reports quote_changed exactly once", () => {
    const accepted = propose(98_000).state;
    const withdrawn = withdrawQuote(accepted);
    expect(withdrawn).toMatchObject({ status: "withdrawn", id: accepted.id, subtotal: 98_000 });
    expect(quoteAdjustment(withdrawn, 100_000)).toBeUndefined();
    expect(toUcpQuote(withdrawn)).toEqual({ status: "withdrawn", id: accepted.id, subtotal: 98_000 });

    const first = advanceQuote(withdrawn, undefined, ctx());
    expect(first.messages).toEqual([expect.objectContaining({ code: "quote_changed" })]);
    expect(advanceQuote(first.state, undefined, ctx()).messages).toEqual([]);
  });

  it("only quoted or accepted quotations can be withdrawn", () => {
    expect(() => withdrawQuote({})).toThrow(/Nothing to withdraw/);
    expect(() => withdrawQuote(propose(92_000).state)).toThrow(/pending/);
  });
});

describe("empty proposal policy (the MAY discussed on #929)", () => {
  it("a policy that needs a figure answers {} with quote_unavailable and leaves state unchanged", () => {
    const strict = ctx({ policy: new ThresholdQuotePolicy(0.03, 0.1, false) });
    const { state, messages } = advanceQuote({}, { proposal: {} }, strict);
    expect(state).toEqual({});
    expect(messages).toEqual([expect.objectContaining({ type: "error", code: "quote_unavailable", severity: "recoverable" })]);
    expect(advanceQuote({}, { proposal: { subtotal: 99_000 } }, strict).state.status).toBe("accepted");
  });
});

describe("out-of-band quotations (accepted by id on a cart)", () => {
  const external: ExternalQuote = { id: "qt_desk_1", accountId: "acme", binding: "lines-A", subtotal: 90_000, expiresAt: new Date(T0.getTime() + DAY) };
  const withBook = (over: Partial<QuoteContext> = {}) => ctx({ resolveExternal: (id) => (id === external.id ? external : undefined), ...over });

  it("binds when account, items and quantities match and it hasn't expired", () => {
    const { state, messages } = advanceQuote({}, { accepted_id: "qt_desk_1" }, withBook());
    expect(state).toMatchObject({ status: "accepted", id: "qt_desk_1", subtotal: 90_000, acceptedId: "qt_desk_1" });
    expect(messages).toEqual([]);
    expect(quoteAdjustment(state, 100_000)).toBe(-10_000);
  });

  it("fails closed for another account, different line items, or after expiry", () => {
    for (const c of [withBook({ accountId: "northwind" }), withBook({ binding: "lines-B" }), withBook({ now: new Date(T0.getTime() + 2 * DAY) })]) {
      const { state, messages } = advanceQuote({}, { accepted_id: "qt_desk_1" }, c);
      expect(state).toEqual({});
      expect(messages[0]).toMatchObject({ code: "quote_changed" });
    }
  });
});
