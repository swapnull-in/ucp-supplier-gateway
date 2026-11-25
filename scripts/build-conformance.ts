import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadDraftQuoteSchema } from "../src/ucp/quote-schema.js";
import { loadVendoredSchemas } from "../src/ucp/schemas.js";

// Builds conformance/package: a single-file, dependency-free CLI with the UCP schemas inlined.
// The bundle is committed so the GitHub Action can run it straight from the repo; CI checks it
// matches the sources.

const pkgDir = fileURLToPath(new URL("../conformance/package/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

writeFileSync(`${pkgDir}schemas.generated.json`, JSON.stringify({ released: loadVendoredSchemas(), draftQuote: loadDraftQuoteSchema() }));

const { version } = JSON.parse(readFileSync(`${pkgDir}package.json`, "utf8")) as { version: string };
await build({
  entryPoints: [`${pkgDir}entry.ts`],
  outfile: `${pkgDir}dist/cli.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  // ajv is CommonJS; give its bundled code a require() in the ESM output.
  banner: { js: `#!/usr/bin/env node\n// ucp-quote-conformance ${version} — Apache-2.0, includes UCP schemas (Apache-2.0)\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  logLevel: "warning",
});

for (const f of ["LICENSE", "NOTICE"]) copyFileSync(`${root}${f}`, `${pkgDir}${f}`);
console.log(`built conformance/package/dist/cli.js (v${version})`);
