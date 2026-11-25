import { parseArgs } from "node:util";
import { formatReport, gatewayAdminHooks, runConformance } from "./runner.js";

// Usage:
//   pnpm conformance --origin https://business.example --token <buyer token> --item SKU:QTY [--item SKU:QTY]
//                    [--proposal 12345] [--admin-token <token> --account-id <id>] [--json]
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    token: { type: "string" },
    item: { type: "string", multiple: true },
    proposal: { type: "string" },
    "agent-profile": { type: "string", default: "https://conformance.invalid/platform-profile.json" },
    "admin-token": { type: "string" },
    "account-id": { type: "string" },
    json: { type: "boolean", default: false },
  },
});

if (!values.origin || !values.token || !values.item?.length) {
  console.error("Required: --origin, --token and at least one --item SKU:QTY");
  process.exit(2);
}
const items = values.item.map((s) => {
  const [id, qty] = s.split(":");
  return { id: id!, quantity: Number(qty ?? 1) };
});

const results = await runConformance({
  origin: values.origin,
  token: values.token,
  agentProfile: values["agent-profile"]!,
  items,
  ...(values.proposal ? { proposalSubtotal: Number(values.proposal) } : {}),
  ...(values["admin-token"] && values["account-id"] ? { hooks: gatewayAdminHooks(values.origin, values["admin-token"], values["account-id"]) } : {}),
});

console.log(values.json ? JSON.stringify(results, null, 2) : formatReport(results));
process.exit(results.some((r) => r.outcome === "fail") ? 1 : 0);
