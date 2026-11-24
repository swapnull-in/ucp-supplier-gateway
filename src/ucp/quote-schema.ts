import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The quote extension schema from UCP PR #930 (proposal #929), vendored unchanged. It is
// registered for validation under its own $id (https://ucp.dev/schemas/common/quote.json) and
// served from the gateway under our namespace until UCP releases it.

const DRAFT_PATH = fileURLToPath(new URL("../../vendor/ucp-drafts/quote-pr930.json", import.meta.url));
export const DRAFT_QUOTE_ID = "https://ucp.dev/schemas/common/quote.json";

export function loadDraftQuoteSchema(): { $id: string } & Record<string, unknown> {
  return JSON.parse(readFileSync(DRAFT_PATH, "utf8"));
}

/** The copy we publish: our $id and name, with relative refs made absolute to ucp.dev. */
export function servedQuoteSchema(schemaUrl: string, capabilityName: string) {
  const draft = loadDraftQuoteSchema();
  const absolutize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(absolutize);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && !v.startsWith("#") ? new URL(v, DRAFT_QUOTE_ID).toString() : absolutize(v)]),
      );
    }
    return node;
  };
  return { ...(absolutize(draft) as object), $id: schemaUrl, name: capabilityName };
}
