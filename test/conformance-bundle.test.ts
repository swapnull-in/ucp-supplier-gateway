import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { OccBackend } from "../src/backend/occ/client.js";
import { buildMockOcc } from "../src/backend/occ/mock-server.js";
import { SCOPE_CART_MANAGE, SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ, StaticAccountResolver } from "../src/ucp/accounts.js";

// Runs the published single-file CLI (conformance/package/dist/cli.js), as npx or the GitHub
// Action would, against a live gateway. `pnpm build:conformance` produces it.
const CLI = fileURLToPath(new URL("../conformance/package/dist/cli.js", import.meta.url));
const run = promisify(execFile);

let occ: FastifyInstance;
let gateway: FastifyInstance;
let origin: string;

beforeAll(async () => {
  occ = buildMockOcc();
  const occUrl = await occ.listen({ port: 0, host: "127.0.0.1" });
  const probe = Fastify();
  const port = Number(new URL(await probe.listen({ port: 0, host: "127.0.0.1" })).port);
  await probe.close();
  origin = `http://127.0.0.1:${port}`;
  gateway = buildApp({
    backend: new OccBackend({ baseUrl: occUrl, siteId: "powertools", tokenFor: async (a) => ({ acme_industrial: "occ-token-acme" })[a.id] }),
    accounts: new StaticAccountResolver({ "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes: [SCOPE_CART_MANAGE, SCOPE_CHECKOUT_MANAGE, SCOPE_ORDER_READ] } }),
    publicOrigin: origin,
    vendorNamespace: "com.example.gateway",
    storefrontOrigin: "https://supplier.example",
    adminToken: "admin-secret",
  });
  await gateway.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  await gateway.close();
  await occ.close();
});

describe.runIf(existsSync(CLI))("published CLI bundle", () => {
  it("passes the reference gateway and prints JSON results", async () => {
    const { stdout } = await run("node", [CLI, "--origin", origin, "--token", "tok-acme", "--item", "SG-220:10", "--item", "HX-1040:20",
      "--admin-token", "admin-secret", "--account-id", "acme_industrial", "--place-orders", "--json"]);
    const results = JSON.parse(stdout) as { outcome: string }[];
    expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
    expect(results.filter((r) => r.outcome === "pass")).toHaveLength(16);
  });

  it("exits 2 on bad usage", async () => {
    await expect(run("node", [CLI, "--origin", origin])).rejects.toMatchObject({ code: 2 });
  });
});
