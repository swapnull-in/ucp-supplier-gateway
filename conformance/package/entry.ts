// Entry point of the published, self-contained CLI: the UCP schemas are inlined at build time
// (scripts/build-conformance.ts), so the bundle needs no repo checkout and no dependencies.
import schemas from "./schemas.generated.json" with { type: "json" };
import { main } from "../main.js";

process.exitCode = await main(process.argv.slice(2), schemas as Parameters<typeof main>[1]);
