# ucp-quote-conformance

Black-box conformance checks for the **UCP quote extension** proposed in
[UCP #929](https://github.com/Universal-Commerce-Protocol/ucp/issues/929) (draft schema: PR #930),
run against **any** UCP Business that advertises it on Cart.

```bash
npx ucp-quote-conformance --origin https://business.example --token <buyer access token> \
  --item SKU-1:10 --item SKU-2:20
```

| Option | Meaning |
|---|---|
| `--origin` | The Business; its `/.well-known/ucp` is read to find the REST endpoint and the extension |
| `--token` | An identity-linked access token for a test buyer account |
| `--item SKU:QTY` | Orderable test items (repeat); a second item enables the extra-line check |
| `--proposal <subtotal>` | For a Business that answers `{}` with `quote_unavailable`: a subtotal it will quote |
| `--admin-token`, `--account-id` | Business hooks for the withdraw and out-of-band vectors (implemented for [ucp-supplier-gateway](https://github.com/swapnull-in/ucp-supplier-gateway)'s admin routes) |
| `--json` | Machine-readable results |

Each vector cites the #929 section it checks. Vectors a black box can't observe (expiry over
time, Checkout and Order projection, Platform behaviour) are reported **N/A** with the reason,
never as passes. Exit code: 0 all observable vectors pass, 1 a vector failed, 2 bad usage.

The UCP schemas (release 2026-08-25, plus the #930 draft) are bundled, so there are no runtime
dependencies. Source, vectors and tests:
[ucp-supplier-gateway/conformance](https://github.com/swapnull-in/ucp-supplier-gateway/tree/main/conformance).

Apache-2.0. Includes UCP schemas, Copyright 2026 UCP Authors, Apache-2.0.
