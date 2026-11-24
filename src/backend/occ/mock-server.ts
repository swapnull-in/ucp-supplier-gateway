import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { OccProduct, OccProductSearchPage } from "./types.js";

// A stand-in for an SAP Commerce 2205 B2B storefront's OCC API, until we have sandbox access.
// Prices depend on the B2B unit behind the bearer token, the way OCC prices a logged-in
// B2B customer's session.

interface MockItem {
  code: string;
  name: string;
  description: string;
  category: string;
  listPrice: number;
  stock: number;
  minOrderQuantity?: number;
  /** Volume breaks as [minQuantity, multiplier on the account's unit price]. */
  volumeBreaks?: [number, number][];
}

const ITEMS: MockItem[] = [
  { code: "HX-1040", name: "Hex Bolt M10 x 40, Zinc Plated (Box of 100)", description: "<p>DIN 933 hex bolt, <b>grade 8.8</b>, zinc plated.</p>", category: "Fasteners", listPrice: 24.9, stock: 1200, minOrderQuantity: 5, volumeBreaks: [[100, 0.95], [500, 0.9]] },
  { code: "HX-1060", name: "Hex Bolt M10 x 60, Zinc Plated (Box of 100)", description: "<p>DIN 933 hex bolt, grade 8.8, zinc plated.</p>", category: "Fasteners", listPrice: 31.5, stock: 40 },
  { code: "NW-10", name: "Hex Nut M10, Zinc Plated (Box of 200)", description: "<p>DIN 934 hex nut.</p>", category: "Fasteners", listPrice: 12.75, stock: 0 },
  { code: "SG-220", name: "Safety Gloves, Cut Level C, Size L (12 pairs)", description: "<p>EN 388 cut-resistant gloves.</p>", category: "Safety", listPrice: 48.0, stock: 300 },
];

/** Contract price multipliers per B2B unit; anything else gets list price. */
const CONTRACT_DISCOUNTS: Record<string, number> = { acme_industrial: 0.82, northwind_mro: 0.9 };

/** Demo OCC tokens: token -> B2B unit id. */
export const MOCK_OCC_TOKENS: Record<string, string> = {
  "occ-token-acme": "acme_industrial",
  "occ-token-northwind": "northwind_mro",
};

export function buildMockOcc(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get<{ Params: { site: string }; Querystring: { query?: string; pageSize?: string } }>(
    "/occ/v2/:site/products/search",
    async (req) => {
      const factor = contractFactor(req);
      const terms = (req.query.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const pageSize = Math.min(Number(req.query.pageSize ?? 20) || 20, 100);
      const hits = ITEMS.filter((i) => terms.every((t) => `${i.name} ${i.category} ${i.code}`.toLowerCase().includes(t)));
      const page: OccProductSearchPage = {
        products: hits.slice(0, pageSize).map((i) => toOccProduct(i, factor, false)),
        pagination: { currentPage: 0, pageSize, totalResults: hits.length },
      };
      return page;
    },
  );

  app.get<{ Params: { site: string; code: string } }>("/occ/v2/:site/products/:code", async (req, reply) => {
    const item = ITEMS.find((i) => i.code === req.params.code);
    if (!item) {
      return reply.code(404).send({ errors: [{ type: "UnknownIdentifierError", message: `Product with code '${req.params.code}' not found!` }] });
    }
    return toOccProduct(item, contractFactor(req), true);
  });

  return app;
}

function contractFactor(req: FastifyRequest): number {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const unit = token ? MOCK_OCC_TOKENS[token] : undefined;
  return unit ? CONTRACT_DISCOUNTS[unit] ?? 1 : 1;
}

// Rounded the way a price row would be stored; JSON numbers, as OCC returns them.
const round2 = (n: number) => Math.round(n * 100) / 100;

function toOccProduct(i: MockItem, factor: number, detail: boolean): OccProduct {
  const unit = round2(i.listPrice * factor);
  const product: OccProduct = {
    code: i.code,
    name: i.name,
    description: i.description,
    url: `/p/${i.code}`,
    price: { currencyIso: "USD", value: unit, priceType: "BUY" },
    stock: { stockLevelStatus: i.stock === 0 ? "outOfStock" : i.stock < 50 ? "lowStock" : "inStock", stockLevel: i.stock },
    categories: [{ code: i.category.toLowerCase(), name: i.category }],
  };
  if (i.minOrderQuantity) product.minOrderQuantity = i.minOrderQuantity;
  if (detail && i.volumeBreaks) {
    product.volumePrices = [[1, 1] as [number, number], ...i.volumeBreaks].map(([minQuantity, m]) => ({
      currencyIso: "USD",
      value: round2(unit * m),
      priceType: "BUY",
      minQuantity,
    }));
  }
  return product;
}
