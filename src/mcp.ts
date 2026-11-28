import type { FastifyInstance, InjectOptions } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

// UCP's MCP binding (shopping/*/mcp.md): each REST operation is an MCP tool; `meta["ucp-agent"]`
// carries the platform profile, results come back as `structuredContent`, business outcomes are
// results, and transport-level failures are JSON-RPC errors with code -32000.
//
// Tools are translated onto the REST routes in-process, so both transports share one
// implementation: same pricing, quotes, access control and idempotency.

/** JSON-RPC error code UCP uses for protocol errors (auth, rate limiting, unavailability). */
export const UCP_PROTOCOL_ERROR = -32000;

type Method = "GET" | "POST" | "PUT";

interface ToolRoute {
  method: Method;
  path: (args: ToolArgs) => string;
  /** Name of the argument carrying the request body, if any. */
  body?: "catalog" | "cart" | "checkout";
  needsId?: boolean;
  description: string;
}

interface ToolArgs {
  meta?: { "ucp-agent"?: { profile?: string }; "idempotency-key"?: string };
  id?: string;
  catalog?: unknown;
  cart?: unknown;
  checkout?: unknown;
}

const enc = encodeURIComponent;

const TOOLS: Record<string, ToolRoute> = {
  search_catalog: { method: "POST", path: () => "/catalog/search", body: "catalog", description: "Search the supplier's catalog. With a linked buyer account, prices are that account's contract prices." },
  lookup_catalog: { method: "POST", path: () => "/catalog/lookup", body: "catalog", description: "Look up products by id or SKU, with account pricing when linked." },
  create_cart: { method: "POST", path: () => "/carts", body: "cart", description: "Create a cart. Linked accounts get contract and volume pricing and may request or propose a quotation via cart.quote." },
  get_cart: { method: "GET", path: (a) => `/carts/${enc(a.id!)}`, needsId: true, description: "Get a cart, re-priced at current account prices and stock." },
  update_cart: { method: "PUT", path: (a) => `/carts/${enc(a.id!)}`, body: "cart", needsId: true, description: "Replace a cart's line items; may propose a price or accept a quotation by id via cart.quote." },
  cancel_cart: { method: "POST", path: (a) => `/carts/${enc(a.id!)}/cancel`, needsId: true, description: "Cancel a cart; returns its last state." },
  create_checkout: { method: "POST", path: () => "/checkout-sessions", body: "checkout", description: "Start a checkout, from a cart via checkout.cart_id (its quote carries over) or from line items. Linked accounts pay on account under Net 30 or Net 60 terms." },
  get_checkout: { method: "GET", path: (a) => `/checkout-sessions/${enc(a.id!)}`, needsId: true, description: "Get a checkout, re-priced at current account prices." },
  update_checkout: { method: "PUT", path: (a) => `/checkout-sessions/${enc(a.id!)}`, body: "checkout", needsId: true, description: "Replace a checkout's line items; may propose or accept a quotation via checkout.quote, or pick a payment term via checkout.payment.selected_term_id." },
  complete_checkout: { method: "POST", path: (a) => `/checkout-sessions/${enc(a.id!)}/complete`, body: "checkout", needsId: true, description: "Place the order. Returns the checkout without an order if the price changed since the last response, so the buyer can review it." },
  cancel_checkout: { method: "POST", path: (a) => `/checkout-sessions/${enc(a.id!)}/cancel`, needsId: true, description: "Cancel an open checkout." },
  get_order: { method: "GET", path: (a) => `/orders/${enc(a.id!)}`, needsId: true, description: "Get an order placed through checkout, with the accepted quotation and payment term." },
};

const META_SCHEMA = {
  type: "object",
  required: ["ucp-agent"],
  properties: {
    "ucp-agent": { type: "object", required: ["profile"], properties: { profile: { type: "string", format: "uri" } } },
    "idempotency-key": { type: "string", description: "Retry key for state-changing tools." },
  },
};

function inputSchema(route: ToolRoute) {
  const properties: Record<string, unknown> = { meta: META_SCHEMA };
  const required = ["meta"];
  if (route.needsId) {
    properties.id = { type: "string" };
    required.push("id");
  }
  if (route.body) {
    properties[route.body] = { type: "object", description: `UCP ${route.body} request payload (https://ucp.dev/specification/).` };
    required.push(route.body);
  }
  return { type: "object", properties, required };
}

/** Statuses that are protocol errors under UCP's two-layer model; everything else is a result. */
const PROTOCOL_ERROR_STATUSES = new Set([400, 401, 403, 409, 413, 429]);

export function registerMcp(app: FastifyInstance, path: string, restBase: string, serverInfo = { name: "ucp-supplier-gateway", version: "0.2.3" }) {
  app.post(path, async (req, reply) => {
    const authorization = req.headers.authorization;
    const headerKey = req.headers["idempotency-key"];

    // Stateless: a fresh server and transport per request, as the SDK recommends without sessions.
    const server = new Server(serverInfo, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(TOOLS).map(([name, route]) => ({ name, description: route.description, inputSchema: inputSchema(route) })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const route = TOOLS[name];
      if (!route) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      const args = (request.params.arguments ?? {}) as ToolArgs;

      const profile = args.meta?.["ucp-agent"]?.profile;
      if (typeof profile !== "string") throw new McpError(ErrorCode.InvalidParams, 'meta["ucp-agent"].profile is required');
      if (route.needsId && (typeof args.id !== "string" || args.id.length === 0)) throw new McpError(ErrorCode.InvalidParams, "id is required");
      const payload = route.body ? args[route.body] : undefined;
      if (route.body && payload !== undefined && (typeof payload !== "object" || payload === null)) {
        throw new McpError(ErrorCode.InvalidParams, `${route.body} must be an object`);
      }
      if ((route.body === "cart" || route.body === "checkout") && payload && "id" in (payload as object)) {
        throw new McpError(ErrorCode.InvalidParams, `${route.body} must not contain id; pass it as the top-level id`);
      }

      const headers: Record<string, string> = { "ucp-agent": `profile="${profile}"` };
      if (authorization) headers.authorization = authorization;
      const key = args.meta?.["idempotency-key"] ?? (typeof headerKey === "string" ? headerKey : undefined);
      if (key) headers["idempotency-key"] = key;
      if (payload !== undefined) headers["content-type"] = "application/json";

      const injected: InjectOptions = { method: route.method, url: `${restBase}${route.path(args)}`, headers };
      if (payload !== undefined) injected.payload = JSON.stringify(payload);
      const res = await app.inject(injected);
      const body = res.json() as Record<string, unknown>;

      if (PROTOCOL_ERROR_STATUSES.has(res.statusCode) || res.statusCode >= 500) {
        const messages = (body.messages as { content?: string }[] | undefined) ?? [];
        throw new McpError(UCP_PROTOCOL_ERROR, messages[0]?.content ?? `HTTP ${res.statusCode}`, body);
      }
      // Results, including business outcomes such as not_found, carry the UCP envelope.
      return { structuredContent: body, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
    });

    // No sessionIdGenerator: stateless mode. JSON responses instead of SSE, since tools reply once.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    // The SDK requires Accept to name both JSON and SSE, but UCP clients often send none or */*
    // (an HTTP library's default). Both accept a JSON reply, so they're served rather than refused.
    const accept = req.raw.headers.accept;
    if (!accept || accept.includes("*/*")) req.raw.headers.accept = "application/json, text/event-stream";
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless server: no standalone SSE stream and no sessions to delete.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({ method, url: path, handler: async (_req, reply) => reply.code(405).header("allow", "POST").send() });
  }
}
