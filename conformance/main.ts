import { parseArgs } from "node:util";
import { type ConformanceConfig, formatReport, gatewayAdminHooks, runConformance } from "./runner.js";

export const USAGE = `Usage: ucp-quote-conformance --origin <https://business.example> --token <buyer access token> --item SKU:QTY [--item SKU:QTY]
       [--proposal <subtotal>] [--admin-token <token> --account-id <id>] [--agent-profile <url>] [--json]

Checks a UCP Business against the quote extension proposed in UCP #929 (draft schema: PR #930).`;

/** Runs the CLI; returns the process exit code (0 all pass, 1 a vector failed, 2 bad usage). */
export async function main(argv: string[], schemas?: ConformanceConfig["schemas"]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      origin: { type: "string" },
      token: { type: "string" },
      item: { type: "string", multiple: true },
      proposal: { type: "string" },
      "agent-profile": { type: "string", default: "https://conformance.invalid/platform-profile.json" },
      "admin-token": { type: "string" },
      "account-id": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!values.origin || !values.token || !values.item?.length) {
    console.error(USAGE);
    return 2;
  }
  const items = values.item.map((s) => {
    const [id, qty] = s.split(":");
    return { id: id!, quantity: Number(qty ?? 1) };
  });
  if (items.some((i) => !i.id || !Number.isInteger(i.quantity) || i.quantity < 1)) {
    console.error("Each --item must be SKU:QTY with a positive integer quantity");
    return 2;
  }

  const results = await runConformance({
    origin: values.origin,
    token: values.token,
    agentProfile: values["agent-profile"]!,
    items,
    ...(values.proposal ? { proposalSubtotal: Number(values.proposal) } : {}),
    ...(values["admin-token"] && values["account-id"] ? { hooks: gatewayAdminHooks(values.origin, values["admin-token"], values["account-id"]) } : {}),
    ...(schemas ? { schemas } : {}),
  });
  console.log(values.json ? JSON.stringify(results, null, 2) : formatReport(results));
  return results.some((r) => r.outcome === "fail") ? 1 : 0;
}
