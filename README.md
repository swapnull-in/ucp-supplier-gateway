# ucp-supplier-gateway

**A reference supplier-side endpoint for the [Universal Commerce Protocol (UCP)](https://ucp.dev),
over REST and MCP, in front of a B2B commerce backend.**

It lets AI agents and procurement platforms search a supplier's catalog, build carts, and
request or negotiate **quotes**, all at the **linked buyer account's contract and volume prices**,
without changing the backend. The first backend adapter targets **SAP Commerce (OCC v2)**,
including on-premise 2205 systems that won't get native agent support.

> **Status: reference implementation, not production-ready.** The SAP backend is a mock built
> from SAP's OCC documentation, buyer identity uses static demo tokens, and stores are
> in-memory. See [Limitations](#limitations).

## Why

B2B buying is quote-led and account-priced: the same item has a different price for every
customer, volume breaks, minimum order quantities, and "call for quote". UCP's B2B work (the
[B2B Procurement charter, #947](https://github.com/Universal-Commerce-Protocol/ucp/issues/947),
and the [quote proposal, #929](https://github.com/Universal-Commerce-Protocol/ucp/issues/929))
is just starting. This project shows, in working and tested code, what the supplier side of
that looks like against a legacy ERP-backed storefront.

## What it implements

| UCP capability | REST | MCP tool | Notes |
|---|---|---|---|
| Discovery | `GET /.well-known/ucp` | — | Business profile advertising REST and MCP services |
| `dev.ucp.shopping.catalog.search` | `POST /ucp/catalog/search` | `search_catalog` | Account pricing with identity linking |
| `dev.ucp.shopping.catalog.lookup` | `POST /ucp/catalog/lookup` | `lookup_catalog` | Batch lookup with `inputs` correlation and `not_found` messages |
| `dev.ucp.shopping.cart` | `POST/GET/PUT /ucp/carts…`, `POST …/cancel` | `create_cart`, `get_cart`, `update_cart`, `cancel_cart` | Contract and volume pricing, MOQ and stock messages, expiry |
| Quote extension ([#929](https://github.com/Universal-Commerce-Protocol/ucp/issues/929), draft) | `quote` on the cart | same tools | Firm quotes, price proposals, pending review, accept by id, invalidation |

Protocol behaviour that's implemented and tested:
- **Conformance:** every response is validated in tests against the **official UCP JSON
  Schemas** (vendored from release `2026-08-25`) and the **draft quote schema** from PR #930.
- **Idempotency** per UCP: SHA-256 of the raw request body, `409` on key reuse with a different
  body, replay with `Idempotent-Replayed: true`, and server errors aren't stored, so retries
  work after recovery. Also honoured for MCP via `meta["idempotency-key"]`.
- **Two-layer errors:** transport errors as HTTP status (REST) or JSON-RPC `-32000` (MCP);
  business outcomes as UCP `messages` with severity and JSONPath `path`.
- **Access control:** carts and quotes are scoped to the buyer account; other accounts get
  `not_found`. Quoting requires a linked account (`identity_required` otherwise).
- **Money** is always integer minor units; decimal backend prices convert without float maths.

## Quick start

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm test          # 69 tests, including schema conformance and a real MCP client
pnpm start         # mock SAP OCC on :9002, gateway on :8080
```

### REST

```bash
H='UCP-Agent: profile="https://agent.example/profile.json"'
A='authorization: Bearer demo-token-acme'     # a linked buyer account (demo token)
J='content-type: application/json'

# Same search, anonymous vs. Acme's contract prices
curl -s -X POST localhost:8080/ucp/catalog/search -H "$H" -H "$J" -d '{"query":"hex bolt"}'
curl -s -X POST localhost:8080/ucp/catalog/search -H "$H" -H "$A" -H "$J" -d '{"query":"hex bolt"}'

# Cart for 500 boxes (volume break) and ask for a firm quote
curl -s -X POST localhost:8080/ucp/carts -H "$H" -H "$A" -H "$J" -H 'idempotency-key: demo-1' \
  -d '{"line_items":[{"item":{"id":"HX-1040"},"quantity":500}],"quote":{"proposal":{}}}'

# Accept it: PUT the same line items with quote.accepted_id = the returned quote.id
```

### MCP

Point any MCP client at `http://localhost:8080/ucp/mcp` (streamable HTTP). Send the buyer's
token as an `Authorization: Bearer` header, and include UCP metadata in every call:

```json
{ "name": "search_catalog",
  "arguments": { "meta": { "ucp-agent": { "profile": "https://agent.example/profile.json" } },
                 "catalog": { "query": "hex bolt" } } }
```

### Quotes, end to end

| Buyer sends (`cart.quote`) | Default policy answers | Result |
|---|---|---|
| `{ "proposal": {} }` | Firm quotation at the current account price | `quoted` with `id` and `expires_at` (a price lock) |
| `{ "proposal": { "subtotal": … } }` within 3% below current | Accept | `accepted`; totals carry one signed `quote` entry |
| … within 10% below | Send to a person | `pending` until answered via `POST /admin/carts/:id/quote` (set `ADMIN_TOKEN`) |
| … lower | Decline | `declined` |
| `{ "accepted_id": "qt_…" }` | Accept that quotation if it's current | `accepted`, or `quote_changed` if stale |
| Line items or quantities change | — | Quotation invalidated, `quote_changed` warning |

The policy is a pluggable interface (`QuotePolicy`), so rules, a model or a sales desk can decide.

## Architecture

```
 AI agent / procurement platform
        │ UCP over REST            │ UCP over MCP (streamable HTTP)
        ▼                          ▼
 ┌──────────── ucp-supplier-gateway ─────────────┐
 │ profile · catalog · cart · quote extension     │  MCP tools are translated onto the
 │ identity → account · idempotency · validation  │  REST routes in-process: one implementation
 │ pricing: contract · volume breaks · MOQ · stock│
 └────────────────────┬───────────────────────────┘
                      │ CommerceBackend port (swappable)
                      ▼
          SAP Commerce OCC v2  (mock included)
```

| Path | What |
|---|---|
| `src/backend/types.ts` | Canonical catalog model and the `CommerceBackend` port |
| `src/backend/occ/` | SAP Commerce OCC v2 adapter, plus a mock B2B storefront |
| `src/pricing.ts` | Pure line pricing: volume breaks, MOQ, stock, currency checks |
| `src/ucp/` | Profile, catalog and cart routes, quote state machine, schemas |
| `src/mcp.ts` | UCP MCP binding (official MCP TypeScript SDK) |
| `src/idempotency.ts` | UCP replay protection |
| `vendor/` | Official UCP schemas (Apache-2.0) and the draft quote schema |

Run against a real OCC system by setting `OCC_BASE_URL` and `OCC_SITE_ID`. In production,
set `PUBLIC_ORIGIN`. The quote extension's namespace is derived from it, so its served schema
passes UCP authority binding.

## Limitations

- **No real SAP system tested yet.** OCC field names follow SAP's documentation and still need
  checking against a 2205 sandbox.
- **Identity linking is stubbed:** static tokens map to buyer accounts. Production needs a UCP
  identity-linking OAuth server.
- **No request signature verification** (RFC 9421) yet.
- **In-memory stores** for carts and idempotency keys; production needs Postgres.
- **No checkout, orders or payments.** Carts and quotes only.
- **The quote extension follows a draft** (#929 / PR #930) and will change with it. It is served
  under the gateway's own namespace until `dev.ucp.common.quote` is released.
- **An accepted quotation is held even if the buyer's price later falls.** The `quote` totals
  entry is `quote.subtotal` minus the current line subtotals, so when the account price drops
  below the quoted subtotal, the entry turns positive and the buyer pays more than today's price.
  The draft spec doesn't say what should happen here; it's raised on
  [#929](https://github.com/Universal-Commerce-Protocol/ucp/issues/929#issuecomment-7138134081),
  and the gateway will follow whatever is agreed.

## Open design questions

1. **Backend credentials per buyer account.** OCC prices a B2B customer's *session*, so account
   pricing needs an OCC token per buyer organisation (a technical customer per unit, token
   exchange, or price rows via the Integration API).
2. **Slow ERP pricing.** Customer prices often come from the ERP (ECC/S/4HANA) in real time.
   The likely answer is caching with short TTLs, and `pending` or async responses when pricing is slow.

## Roadmap

- Postgres stores; RFC 9421 signature verification; real identity linking
- Track #929 / #877 / #969 as they evolve; per-line quoted prices if the spec adds them
- Checkout and order, with async completion (`complete_in_progress`) for slow backends
- A second backend adapter

## Contributing

Issues and pull requests are welcome, especially from people running SAP Commerce or other
B2B backends who can test against real systems. Please run `pnpm test` and `pnpm typecheck`
before opening a PR.

## License

[Apache-2.0](LICENSE). Includes UCP schemas under Apache-2.0; see [NOTICE](NOTICE).
