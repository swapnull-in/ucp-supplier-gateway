import { randomUUID } from "node:crypto";
import { DRAFT_QUOTE_ID, loadDraftQuoteSchema } from "../src/ucp/quote-schema.js";
import { UcpSchemas } from "../src/ucp/schemas.js";

// Black-box conformance checks for the UCP quote extension proposed in #929 (draft schema:
// PR #930), run over REST against any Business that advertises it on a Cart. Each vector cites
// the #929 section it checks. What can't be observed from outside (time passing, Platform
// behaviour) is reported N/A with the reason, never as a pass. Checkout vectors run when the
// Business advertises Checkout; the ones that place orders run only with `placeOrders`.

export type Outcome = "pass" | "fail" | "skip" | "n/a";

export interface VectorResult {
  id: string;
  title: string;
  ref: string;
  outcome: Outcome;
  detail: string;
}

/** Business-side actions a black box can't trigger; supply them to run the hook vectors. */
export interface BusinessHooks {
  withdraw(cartId: string): Promise<void>;
  /** Issues a quotation outside any cart for the Buyer behind the token; returns its id. */
  issueQuote(input: { currency: string; subtotal: number; lines: { itemId: string; quantity: number }[] }): Promise<string>;
}

export interface ConformanceConfig {
  /** Origin of the Business, e.g. https://agents.supplier.example (its /.well-known/ucp is read). */
  origin: string;
  /** Identity-linked access token for a test buyer account. */
  token: string;
  /** Platform profile URL sent in UCP-Agent. */
  agentProfile: string;
  /** Orderable test items; the second is used for extra-line checks when present. */
  items: { id: string; quantity: number }[];
  /** Used when the Business answers `{}` with quote_unavailable: a subtotal it will quote or accept. */
  proposalSubtotal?: number;
  hooks?: BusinessHooks;
  /** Complete checkouts to check Order projection. This places real orders on the Business. */
  placeOrders?: boolean;
  fetch?: typeof fetch;
  /** Pre-loaded schemas (the bundled CLI ships them inline); defaults to the vendored files. */
  schemas?: { released: readonly object[]; draftQuote: { $id: string } };
}

type Json = Record<string, any>;
interface Res {
  status: number;
  body: Json;
}

const NOT_OBSERVABLE: [string, string, string, string][] = [
  ["Q-EXP", "A quotation past expires_at is reported expired, never withdrawn", "§6", "needs time to pass"],
  ["Q-LAPSE", "An accepted quotation does not lapse", "§6", "needs time to pass"],
  ["Q-CUR", "A currency change invalidates an accepted quotation", "§6", "currency is set by the Business, not the request"],
  ["Q-UNIT", "A quantity_unit change invalidates an accepted quotation", "§6", "needs items with alternative sale units"],
  ["Q-UNK", "An unrecognized status is shown without an accept affordance", "§2", "Platform behaviour, not Business"],
  ["Q-PRICE", "A quotation never stands above a fallen price; it is re-issued as quoted", "proposed in #929 thread", "needs the Business's price to change; not yet in the spec"],
];

export async function runConformance(cfg: ConformanceConfig): Promise<VectorResult[]> {
  const http = cfg.fetch ?? globalThis.fetch;
  const results: VectorResult[] = [];
  const record = (id: string, title: string, ref: string, outcome: Outcome, detail = "") => results.push({ id, title, ref, outcome, detail });

  // Discovery
  const profileRes = await http(new URL("/.well-known/ucp", cfg.origin));
  const profile = (await profileRes.json()) as Json;
  const rest = (profile.ucp?.services?.["dev.ucp.shopping"] ?? []).find((s: Json) => s.transport === "rest");
  const caps: Json = profile.ucp?.capabilities ?? {};
  const quoteCap = Object.keys(caps).find((name) => (name === "dev.ucp.common.quote" || name.endsWith(".common.quote")) && extendsCart(caps[name]));
  if (!rest || !caps["dev.ucp.shopping.cart"] || !quoteCap) {
    const why = !rest ? "no REST shopping service" : !caps["dev.ucp.shopping.cart"] ? "Cart not advertised" : "no quote extension extending Cart";
    record("DISCOVERY", "Business advertises Cart and the quote extension", "§10", "fail", why);
    return results;
  }
  record("DISCOVERY", "Business advertises Cart and the quote extension", "§10", "pass", `${quoteCap} at ${rest.endpoint}`);

  const schemas = cfg.schemas ? new UcpSchemas(cfg.schemas.released) : new UcpSchemas();
  schemas.addSchema(cfg.schemas?.draftQuote ?? loadDraftQuoteSchema());
  const schemaErrors: string[] = [];
  let checkedResponses = 0;

  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const headers: Record<string, string> = {
      "ucp-agent": `profile="${cfg.agentProfile}"`,
      authorization: `Bearer ${cfg.token}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = randomUUID();
      init.body = JSON.stringify(body);
    }
    const res = await http(`${rest.endpoint}${path}`, init);
    const json = (await res.json().catch(() => ({}))) as Json;
    const resource = path.startsWith("/carts") ? "cart" : path.startsWith("/checkout-sessions") ? "checkout" : path.startsWith("/orders") ? "order" : undefined;
    if (resource && res.ok && json.id && Array.isArray(json.line_items)) {
      checkedResponses++;
      const v = schemas.validateAbsolute(`${DRAFT_QUOTE_ID}#/$defs/dev.ucp.shopping.${resource}`, json);
      if (!v.valid) schemaErrors.push(`${method} ${path}: ${v.errors.slice(0, 2).join("; ")}`);
    }
    return { status: res.status, body: json };
  };

  const lineItems = (items: { id: string; quantity: number }[]) => items.map((i) => ({ item: { id: i.id }, quantity: i.quantity }));
  const base = [cfg.items[0]!];
  const createCart = (quote?: Json, items = base) => call("POST", "/carts", quote ? { line_items: lineItems(items), quote } : { line_items: lineItems(items) });
  const updateCart = (id: string, quote?: Json, items = base) => call("PUT", `/carts/${encodeURIComponent(id)}`, quote ? { line_items: lineItems(items), quote } : { line_items: lineItems(items) });

  /** A cart holding a `quoted` quotation: `{}` first, the configured proposal as fallback. */
  const openQuotation = async (): Promise<Json | undefined> => {
    let cart = (await createCart({ proposal: {} })).body;
    if (cart.quote?.status === "quoted") return cart;
    if (cfg.proposalSubtotal !== undefined && cart.id) {
      cart = (await updateCart(cart.id, { proposal: { subtotal: cfg.proposalSubtotal } })).body;
      if (cart.quote?.status === "quoted") return cart;
    }
    return undefined;
  };

  // Q-IDLE
  const idle = (await createCart()).body;
  if (!idle.id) {
    record("Q-IDLE", "A quotable cart carries quote {} with no cycle open", "§1", "fail", `create failed: ${firstMessage(idle)}`);
    return finish();
  }
  if (idle.quote === undefined) record("Q-IDLE", "A quotable cart carries quote {} with no cycle open", "§1", "skip", "quote omitted: the Business says this cart isn't quotable");
  else record("Q-IDLE", "A quotable cart carries quote {} with no cycle open", "§1", isEmpty(idle.quote) ? "pass" : "fail", isEmpty(idle.quote) ? "" : JSON.stringify(idle.quote));

  // Q-QUOTED
  const quoted = await openQuotation();
  if (!quoted) {
    record("Q-QUOTED", "A quotation has an id, an integer subtotal and a future expires_at", "§6", "skip", "couldn't obtain a quoted quotation; set proposalSubtotal");
    for (const [id, title, ref] of [["Q-ACCEPT", "Accepting by id reflects exactly one quote totals entry", "§4, §5"], ["Q-REPEAT", "Repeating the current accepted_id is a no-op", "§4"], ["Q-IMMUT", "A quotation's subtotal never changes for its id", "§6"], ["Q-INVAL", "Changing quantity invalidates the accepted quotation", "§6"], ["Q-REUSE", "An invalidated id can't be accepted again", "§4"]] as const) {
      record(id, title, ref, "skip", "no quotation to work with");
    }
  } else {
    const q = quoted.quote;
    const okShape = typeof q.id === "string" && Number.isInteger(q.subtotal) && typeof q.expires_at === "string" && Date.parse(q.expires_at) > Date.now();
    record("Q-QUOTED", "A quotation has an id, an integer subtotal and a future expires_at", "§6", okShape ? "pass" : "fail", okShape ? "" : JSON.stringify(q));

    // Q-ACCEPT
    const accepted = (await updateCart(quoted.id, { accepted_id: q.id })).body;
    const entries = (accepted.totals ?? []).filter((t: Json) => t.type === "quote");
    const lineSum = (accepted.line_items ?? []).reduce((sum: number, li: Json) => sum + (li.totals?.find((t: Json) => t.type === "subtotal")?.amount ?? 0), 0);
    const acceptProblems: string[] = [];
    if (accepted.quote?.status !== "accepted") acceptProblems.push(`status ${accepted.quote?.status}`);
    if (accepted.quote?.accepted_id !== q.id) acceptProblems.push("accepted_id not echoed");
    if (entries.length !== 1) acceptProblems.push(`${entries.length} quote entries`);
    else {
      if (entries[0].amount !== accepted.quote.subtotal - lineSum) acceptProblems.push(`entry ${entries[0].amount} != subtotal ${accepted.quote.subtotal} - lines ${lineSum}`);
      if (!entries[0].display_text) acceptProblems.push("entry lacks display_text");
    }
    record("Q-ACCEPT", "Accepting by id reflects exactly one quote totals entry", "§4, §5", acceptProblems.length ? "fail" : "pass", acceptProblems.join("; "));

    // Q-REPEAT
    const again = (await updateCart(quoted.id, { accepted_id: q.id })).body;
    const repeatOk = again.quote?.status === "accepted" && again.quote?.id === q.id && !hasCode(again, "quote_changed");
    record("Q-REPEAT", "Repeating the current accepted_id is a no-op", "§4", repeatOk ? "pass" : "fail", repeatOk ? "" : JSON.stringify({ quote: again.quote, codes: codes(again) }));

    // Q-IMMUT
    const read = (await call("GET", `/carts/${encodeURIComponent(quoted.id)}`)).body;
    const immutOk = read.quote?.id === q.id && read.quote?.subtotal === q.subtotal;
    record("Q-IMMUT", "A quotation's subtotal never changes for its id", "§6", immutOk ? "pass" : "fail", immutOk ? "" : `read ${JSON.stringify(read.quote)} vs issued ${q.subtotal}`);

    // Q-INVAL
    const bumped = [{ id: base[0]!.id, quantity: base[0]!.quantity + 1 }];
    const changed = (await updateCart(quoted.id, undefined, bumped)).body;
    const entryLeft = (changed.totals ?? []).some((t: Json) => t.type === "quote");
    const requoted = changed.quote?.status === "accepted" && changed.quote?.id !== q.id;
    const invalOk = hasCode(changed, "quote_changed") && (!entryLeft || requoted) && changed.quote?.id !== q.id;
    record("Q-INVAL", "Changing quantity invalidates the accepted quotation", "§6", invalOk ? "pass" : "fail", invalOk ? "" : JSON.stringify({ quote: changed.quote, codes: codes(changed), entryLeft }));

    // Q-REUSE
    const reuse = (await updateCart(quoted.id, { accepted_id: q.id }, bumped)).body;
    const reuseOk = reuse.quote?.status !== "accepted" || reuse.quote?.id !== q.id;
    const reusePass = reuseOk && hasCode(reuse, "quote_changed");
    record("Q-REUSE", "An invalidated id can't be accepted again", "§4", reusePass ? "pass" : "fail", reusePass ? "" : JSON.stringify({ quote: reuse.quote, codes: codes(reuse) }));
  }

  // Q-STALE
  const fresh = (await createCart()).body;
  const stale = (await updateCart(fresh.id, { accepted_id: `qt_conformance_${randomUUID()}` })).body;
  const staleOk = stale.quote?.status !== "accepted" && hasCode(stale, "quote_changed") && !(stale.totals ?? []).some((t: Json) => t.type === "quote");
  record("Q-STALE", "An unknown accepted_id fails closed with quote_changed", "§4", staleOk ? "pass" : "fail", staleOk ? "" : JSON.stringify({ quote: stale.quote, codes: codes(stale) }));

  // Q-BOTH
  const before = (await createCart({ proposal: {} })).body;
  const both = (await updateCart(before.id, { proposal: {}, accepted_id: before.quote?.id ?? "qt_any" })).body;
  const err = (both.messages ?? []).find((m: Json) => m.code === "quote_unavailable");
  const bothOk = err?.type === "error" && err?.severity === "recoverable" && sameQuote(both.quote, before.quote);
  record("Q-BOTH", "proposal plus accepted_id is refused with quote_unavailable, quote unchanged", "§3", bothOk ? "pass" : "fail", bothOk ? "" : JSON.stringify({ quote: both.quote, codes: codes(both) }));

  // Hook vectors
  if (!cfg.hooks) {
    record("Q-WITHDRAW", "A withdrawn quotation keeps its id and subtotal and loses its totals entry", "§6", "skip", "needs Business hooks");
    record("Q-OOB", "A quotation issued outside the cart binds by items, quantities and currency", "§4, §6", "skip", "needs Business hooks");
  } else {
    const w = await openQuotation();
    if (!w) record("Q-WITHDRAW", "A withdrawn quotation keeps its id and subtotal and loses its totals entry", "§6", "skip", "couldn't obtain a quotation");
    else {
      await cfg.hooks.withdraw(w.id);
      const after = (await call("GET", `/carts/${encodeURIComponent(w.id)}`)).body;
      const ok = after.quote?.status === "withdrawn" && after.quote?.id === w.quote.id && after.quote?.subtotal === w.quote.subtotal
        && !(after.totals ?? []).some((t: Json) => t.type === "quote") && hasCode(after, "quote_changed");
      record("Q-WITHDRAW", "A withdrawn quotation keeps its id and subtotal and loses its totals entry", "§6", ok ? "pass" : "fail", ok ? "" : JSON.stringify({ quote: after.quote, codes: codes(after) }));
    }

    const items = cfg.items.slice(0, 2);
    const currency = idle.currency as string;
    const lineSum = (idle.line_items ?? []).reduce((s: number, li: Json) => s + (li.totals?.find((t: Json) => t.type === "subtotal")?.amount ?? 0), 0);
    const oobId = await cfg.hooks.issueQuote({ currency, subtotal: Math.max(0, Math.floor(lineSum * 0.95)), lines: base.map((i) => ({ itemId: i.id, quantity: i.quantity })) });
    const ok = (await createCart({ accepted_id: oobId })).body;
    const oobProblems: string[] = [];
    if (ok.quote?.status !== "accepted" || ok.quote?.id !== oobId) oobProblems.push(`matching cart: ${JSON.stringify(ok.quote)}`);
    if (items.length > 1) {
      const extra = (await createCart({ accepted_id: oobId }, items)).body;
      if (extra.quote?.status === "accepted" || !hasCode(extra, "quote_changed")) oobProblems.push(`extra line accepted: ${JSON.stringify(extra.quote)}`);
    }
    record("Q-OOB", "A quotation issued outside the cart binds by items, quantities and currency", "§4, §6", oobProblems.length ? "fail" : "pass",
      oobProblems.join("; ") || (items.length > 1 ? "" : "extra-line check skipped: configure a second item"));
  }

  await checkoutVectors();
  return finish();

  /** Cart to Checkout (Q-CO), and with `placeOrders`, the Order projection (Q-ORDER, Q-DONE). */
  async function checkoutVectors() {
    const titles = {
      "Q-CO": ["Cart to Checkout carries the quote id and status", "§9"],
      "Q-ORDER": ["The Order carries only the accepted quotation's {id, subtotal}", "§9"],
      "Q-DONE": ["Completion while quoted closes the cycle without an Order quote", "§8"],
    } as const;
    const put = (id: keyof typeof titles, outcome: Outcome, detail = "") => record(id, titles[id][0], titles[id][1], outcome, detail);
    const all = Object.keys(titles) as (keyof typeof titles)[];
    if (!caps["dev.ucp.shopping.checkout"] || !extendsTo(caps[quoteCap!], "dev.ucp.shopping.checkout")) {
      for (const id of all) put(id, "n/a", "the Business doesn't advertise Checkout with the quote extension");
      return;
    }
    const toCheckout = async (cartId: string) => (await call("POST", "/checkout-sessions", { cart_id: cartId, line_items: [] })).body;
    const probe = await call("POST", "/checkout-sessions", { cart_id: idle.id, line_items: [] });
    if (probe.status === 401 || probe.status === 403) {
      for (const id of all) put(id, "skip", `the token can't create checkouts (HTTP ${probe.status}); grant dev.ucp.shopping.checkout:manage`);
      return;
    }
    if (probe.body.id && !cfg.placeOrders) await call("POST", `/checkout-sessions/${encodeURIComponent(probe.body.id)}/cancel`, {});

    // Q-CO: an accepted quotation keeps its id and status; so does a quoted one.
    const quotedCart = await openQuotation();
    if (!quotedCart) {
      for (const id of all) put(id, "skip", "couldn't obtain a quoted quotation");
      return;
    }
    const quotedCheckout = await toCheckout(quotedCart.id);
    const acceptedCart = await openQuotation();
    const accepted: Json = acceptedCart ? (await updateCart(acceptedCart.id, { accepted_id: acceptedCart.quote.id })).body : {};
    const acceptedCheckout = accepted.quote?.status === "accepted" ? await toCheckout(accepted.id) : undefined;
    const coProblems: string[] = [];
    if (!quotedCheckout.id) coProblems.push(`create from cart failed: ${firstMessage(quotedCheckout)}`);
    else if (quotedCheckout.quote?.status !== "quoted" || quotedCheckout.quote?.id !== quotedCart.quote.id) coProblems.push(`quoted cart became ${JSON.stringify(quotedCheckout.quote)}`);
    if (!acceptedCheckout) coProblems.push("couldn't accept a quotation to convert");
    else {
      if (acceptedCheckout.quote?.status !== "accepted" || acceptedCheckout.quote?.id !== accepted.quote.id) coProblems.push(`accepted cart became ${JSON.stringify(acceptedCheckout.quote)}`);
      const entries = (acceptedCheckout.totals ?? []).filter((t: Json) => t.type === "quote");
      if (entries.length !== 1) coProblems.push(`${entries.length} quote entries on the Checkout`);
    }
    put("Q-CO", coProblems.length ? "fail" : "pass", coProblems.join("; "));

    if (!cfg.placeOrders) {
      put("Q-ORDER", "skip", "needs --place-orders (places real orders on the Business)");
      put("Q-DONE", "skip", "needs --place-orders (places real orders on the Business)");
      for (const c of [quotedCheckout, acceptedCheckout]) if (c?.id) await call("POST", `/checkout-sessions/${encodeURIComponent(c.id)}/cancel`, {});
      return;
    }

    /** Completes a Checkout with `payment: {}` and reads its Order, or says why it couldn't. */
    const place = async (checkout: Json | undefined): Promise<{ order?: Json; why?: string }> => {
      if (!checkout?.id) return { why: "no checkout" };
      const done = (await call("POST", `/checkout-sessions/${encodeURIComponent(checkout.id)}/complete`, { payment: {} })).body;
      if (done.status !== "completed" || !done.order?.id) return { why: `not completed with payment {}: status ${done.status}, ${firstMessage(done)}` };
      if (!caps["dev.ucp.shopping.order"]) return { why: "completed, but the Order capability isn't advertised" };
      const order = (await call("GET", `/orders/${encodeURIComponent(done.order.id)}`)).body;
      return order.id ? { order } : { why: `Get Order failed: ${firstMessage(order)}` };
    };

    const placedAccepted = await place(acceptedCheckout);
    if (!placedAccepted.order) put("Q-ORDER", "skip", placedAccepted.why);
    else {
      const q = placedAccepted.order.quote;
      const ok = q && Object.keys(q).sort().join() === "id,subtotal" && q.id === accepted.quote.id && q.subtotal === accepted.quote.subtotal;
      put("Q-ORDER", ok ? "pass" : "fail", ok ? "" : `Order quote ${JSON.stringify(q)}`);
    }

    const placedQuoted = await place(quotedCheckout);
    if (!placedQuoted.order) put("Q-DONE", "skip", placedQuoted.why);
    else put("Q-DONE", placedQuoted.order.quote === undefined ? "pass" : "fail", placedQuoted.order.quote === undefined ? "" : `Order quote ${JSON.stringify(placedQuoted.order.quote)}`);
  }

  function finish() {
    record("SCHEMA", `Cart, Checkout and Order responses validate against the #930 draft schema`, "§10", schemaErrors.length ? "fail" : checkedResponses ? "pass" : "skip",
      schemaErrors.length ? schemaErrors.slice(0, 3).join(" | ") : `${checkedResponses} responses checked`);
    for (const [id, title, ref, why] of NOT_OBSERVABLE) record(id, title, ref, "n/a", why);
    return results;
  }
}

function extendsTo(entries: Json[], capability: string): boolean {
  return (entries ?? []).some((e) => (Array.isArray(e.extends) ? e.extends : [e.extends]).includes(capability));
}

const extendsCart = (entries: Json[]) => extendsTo(entries, "dev.ucp.shopping.cart");

const codes = (body: Json): string[] => (body.messages ?? []).map((m: Json) => m.code);
const hasCode = (body: Json, code: string) => codes(body).includes(code);
const isEmpty = (o: unknown) => !!o && typeof o === "object" && Object.keys(o as object).length === 0;
const sameQuote = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const firstMessage = (body: Json) => body.messages?.[0]?.content ?? "no message";

/** Hooks for this gateway's admin routes (`ADMIN_TOKEN`), the reference implementation. */
export function gatewayAdminHooks(origin: string, adminToken: string, accountId: string, http: typeof fetch = globalThis.fetch): BusinessHooks {
  const post = async (path: string, body: unknown) => {
    const res = await http(new URL(path, origin), { method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return (await res.json()) as Json;
  };
  return {
    withdraw: async (cartId) => void (await post(`/admin/carts/${encodeURIComponent(cartId)}/quote`, { status: "withdrawn" })),
    issueQuote: async ({ currency, subtotal, lines }) =>
      (await post("/admin/quotes", { account_id: accountId, currency, subtotal, line_items: lines.map((l) => ({ item: { id: l.itemId }, quantity: l.quantity })) })).id,
  };
}

export function formatReport(results: VectorResult[]): string {
  const width = Math.max(...results.map((r) => r.id.length));
  const mark: Record<Outcome, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", "n/a": "N/A " };
  const lines = results.map((r) => `${mark[r.outcome]}  ${r.id.padEnd(width)}  ${r.title} (${r.ref})${r.detail ? `\n${" ".repeat(width + 8)}${r.detail}` : ""}`);
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  return `${lines.join("\n")}\n\n${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped, ${count("n/a")} not observable`;
}
