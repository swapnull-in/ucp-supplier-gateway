import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatReport, gatewayAdminHooks, runConformance, type VectorResult } from "../conformance/runner.js";
import { buildApp } from "../src/app.js";
import { OccBackend } from "../src/backend/occ/client.js";
import { buildMockOcc } from "../src/backend/occ/mock-server.js";
import { SCOPE_CART_MANAGE, SCOPE_CATALOG_LOOKUP, SCOPE_CATALOG_SEARCH, StaticAccountResolver } from "../src/ucp/accounts.js";

let occ: FastifyInstance;
let gateway: FastifyInstance;
let origin: string;

beforeAll(async () => {
  occ = buildMockOcc();
  const occUrl = await occ.listen({ port: 0, host: "127.0.0.1" });
  const scopes = [SCOPE_CATALOG_SEARCH, SCOPE_CATALOG_LOOKUP, SCOPE_CART_MANAGE];
  // The served profile must point at the address the runner can reach, so bind first.
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  gateway = buildApp({
    backend: new OccBackend({ baseUrl: occUrl, siteId: "powertools", tokenFor: async (a) => ({ acme_industrial: "occ-token-acme" })[a.id] }),
    accounts: new StaticAccountResolver({ "tok-acme": { account: { id: "acme_industrial", name: "Acme" }, scopes } }),
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

const config = () => ({
  origin,
  token: "tok-acme",
  agentProfile: "https://agent.example/profile.json",
  items: [{ id: "SG-220", quantity: 10 }, { id: "HX-1040", quantity: 20 }],
});
const byId = (results: VectorResult[]) => Object.fromEntries(results.map((r) => [r.id, r]));

describe("conformance runner against the reference gateway", () => {
  it("passes every observable vector, with hooks", async () => {
    const results = await runConformance({ ...config(), hooks: gatewayAdminHooks(origin, "admin-secret", "acme_industrial") });
    const failures = results.filter((r) => r.outcome === "fail");
    expect(failures, formatReport(results)).toEqual([]);
    const r = byId(results);
    for (const id of ["DISCOVERY", "Q-IDLE", "Q-QUOTED", "Q-ACCEPT", "Q-REPEAT", "Q-IMMUT", "Q-INVAL", "Q-REUSE", "Q-STALE", "Q-BOTH", "Q-WITHDRAW", "Q-OOB", "SCHEMA"]) {
      expect(r[id]?.outcome, `${id}: ${r[id]?.detail}`).toBe("pass");
    }
    expect(results.filter((x) => x.outcome === "n/a")).toHaveLength(8);
  });

  it("skips Business-side vectors without hooks instead of passing them", async () => {
    const r = byId(await runConformance(config()));
    expect(r["Q-WITHDRAW"]!.outcome).toBe("skip");
    expect(r["Q-OOB"]!.outcome).toBe("skip");
  });
});

describe("conformance runner catches broken Businesses", () => {
  it("fails a Business that invalidates quotations silently (no quote_changed)", async () => {
    const proxy = await proxyServer(origin, (body) => {
      if (Array.isArray(body.messages)) body.messages = body.messages.filter((m: { code?: string }) => m.code !== "quote_changed");
      return body;
    });
    const r = byId(await runConformance({ ...config(), origin: proxy.origin, fetch: proxy.fetch }));
    expect(r["Q-INVAL"]!.outcome).toBe("fail");
    expect(r["Q-STALE"]!.outcome).toBe("fail");
    expect(r["Q-ACCEPT"]!.outcome).toBe("pass");
    await proxy.close();
  });

  it("fails a Business that emits two quote totals entries", async () => {
    const proxy = await proxyServer(origin, (body) => {
      const entry = Array.isArray(body.totals) ? body.totals.find((t: { type: string }) => t.type === "quote") : undefined;
      if (entry) body.totals.splice(1, 0, { ...entry });
      return body;
    });
    const r = byId(await runConformance({ ...config(), origin: proxy.origin, fetch: proxy.fetch }));
    expect(r["Q-ACCEPT"]!.outcome).toBe("fail");
    expect(r["Q-ACCEPT"]!.detail).toContain("2 quote entries");
    await proxy.close();
  });

  it("fails discovery when the quote extension isn't advertised", async () => {
    const proxy = await proxyServer(origin, (body) => {
      const caps = body.ucp?.capabilities;
      if (caps) for (const k of Object.keys(caps)) if (k.endsWith(".common.quote")) delete caps[k];
      return body;
    });
    const results = await runConformance({ ...config(), origin: proxy.origin, fetch: proxy.fetch });
    expect(results).toEqual([expect.objectContaining({ id: "DISCOVERY", outcome: "fail" })]);
    await proxy.close();
  });
});

/**
 * A proxy that rewrites JSON responses from the gateway. The gateway's profile advertises its own
 * origin, so the runner's fetch is redirected through the proxy for every request.
 */
async function proxyServer(target: string, mutate: (body: any) => any) {
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.all("/*", async (req, reply) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "connection"].includes(k))) as Record<string, string>;
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined && req.method !== "GET") init.body = req.body as string;
    const res = await fetch(new URL(req.url, target), init);
    const text = await res.text();
    let out: unknown = text;
    try {
      out = mutate(JSON.parse(text));
    } catch {
      // not JSON: pass through
    }
    return reply.code(res.status).header("content-type", "application/json").send(out);
  });
  const proxyOrigin = await app.listen({ port: 0, host: "127.0.0.1" });
  const redirect: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    return fetch(new URL(url.pathname + url.search, proxyOrigin), init);
  };
  return { origin: proxyOrigin, fetch: redirect, close: () => app.close() };
}

async function freePort(): Promise<number> {
  const probe = Fastify();
  const address = await probe.listen({ port: 0, host: "127.0.0.1" });
  await probe.close();
  return Number(new URL(address).port);
}
