import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const UCP_VERSION = "2026-08-25";

const SCHEMA_ROOT = fileURLToPath(new URL(`../../vendor/ucp-schemas/${UCP_VERSION}/`, import.meta.url));

/**
 * Validator over the official UCP JSON Schemas vendored from the spec repo.
 * Refs are resolved by `$id` (https://ucp.dev/schemas/...), so `schemaRef` takes the
 * repo-relative path plus an optional JSON pointer, e.g. "shopping/catalog_search.json#/$defs/search_response".
 */
export class UcpSchemas {
  readonly #ajv: Ajv2020;
  readonly #cache = new Map<string, ValidateFunction>();

  /** `schemas` replaces reading the vendored files, e.g. when they're bundled into one file. */
  constructor(schemas: readonly object[] = loadVendoredSchemas()) {
    // UCP schemas carry their own annotation keywords (ucp_request, ...), so strict mode is off.
    this.#ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(this.#ajv);
    for (const schema of schemas) this.#ajv.addSchema(schema);
  }

  /** Registers an additional schema (e.g. a vendor capability) that may $ref UCP schemas. */
  addSchema(schema: { $id: string }): void {
    this.#ajv.addSchema(schema);
  }

  /** Like `validate`, but for a schema registered by absolute `$id` (plus optional pointer). */
  validateAbsolute(ref: string, data: unknown): { valid: true } | { valid: false; errors: string[] } {
    return this.validate(ref, data, ref);
  }

  validate(schemaRef: string, data: unknown, absoluteRef = `https://ucp.dev/schemas/${schemaRef}`): { valid: true } | { valid: false; errors: string[] } {
    let fn = this.#cache.get(schemaRef);
    if (!fn) {
      fn = this.#ajv.getSchema(absoluteRef);
      if (!fn) throw new Error(`Unknown UCP schema: ${schemaRef}`);
      this.#cache.set(schemaRef, fn);
    }
    if (fn(data)) return { valid: true };
    return { valid: false, errors: (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()) };
  }
}

/** The released UCP schemas vendored in this repo, parsed. */
export function loadVendoredSchemas(): object[] {
  return listJson(SCHEMA_ROOT).map((file) => JSON.parse(readFileSync(file, "utf8")) as object);
}

function listJson(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
}
