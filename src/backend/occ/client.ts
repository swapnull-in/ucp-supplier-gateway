import { toMinorUnits } from "../../money.js";
import type { BuyerAccount, CatalogProduct, CommerceBackend, PriceTier, SearchQuery, StockStatus } from "../types.js";
import type { OccProduct, OccProductSearchPage } from "./types.js";

export interface OccBackendOptions {
  /** e.g. https://commerce.example.com — `/occ/v2/{siteId}` is appended. */
  baseUrl: string;
  siteId: string;
  /**
   * OCC bearer token for a buyer account, or undefined to call anonymously.
   * OCC resolves B2B prices from the logged-in customer's B2B unit, so account pricing
   * needs a backend credential per account. How to obtain one (a technical customer per unit,
   * token exchange, ...) is an open design question; see README.
   */
  tokenFor?: (account: BuyerAccount) => Promise<string | undefined>;
  timeoutMs?: number;
  /** Upper bound on parallel product-detail requests during a lookup. */
  maxConcurrency?: number;
  fetch?: typeof fetch;
}

export class OccBackendError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OccBackendError";
  }
}

export class OccBackend implements CommerceBackend {
  readonly #opts: Required<Pick<OccBackendOptions, "timeoutMs" | "maxConcurrency" | "fetch">> & OccBackendOptions;

  constructor(opts: OccBackendOptions) {
    this.#opts = { timeoutMs: 5000, maxConcurrency: 8, fetch: globalThis.fetch, ...opts };
  }

  async searchProducts(query: SearchQuery): Promise<CatalogProduct[]> {
    const page = await this.#get<OccProductSearchPage>(
      "products/search",
      { query: query.text, pageSize: String(query.limit), fields: "FULL" },
      query.account,
    );
    // Products without a buy price can't be offered to an agent, so they are skipped.
    return (page?.products ?? []).filter((p) => p.price).map(toCatalogProduct);
  }

  async getProducts(ids: string[], account?: BuyerAccount): Promise<CatalogProduct[]> {
    // OCC has no batch product endpoint, so this fans out with a concurrency cap.
    const results: (OccProduct | undefined)[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        results[i] = await this.#get<OccProduct>(`products/${encodeURIComponent(ids[i]!)}`, { fields: "FULL" }, account);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#opts.maxConcurrency, ids.length) }, worker));
    return results.filter((p): p is OccProduct => p?.price !== undefined).map(toCatalogProduct);
  }

  /** GET against the OCC site; resolves undefined on 404, throws on other failures. */
  async #get<T>(path: string, params: Record<string, string>, account?: BuyerAccount): Promise<T | undefined> {
    const url = new URL(`${this.#opts.baseUrl}/occ/v2/${encodeURIComponent(this.#opts.siteId)}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const headers: Record<string, string> = { accept: "application/json" };
    if (account && this.#opts.tokenFor) {
      const token = await this.#opts.tokenFor(account);
      if (token) headers.authorization = `Bearer ${token}`;
    }

    let res: Response;
    try {
      res = await this.#opts.fetch(url, { headers, signal: AbortSignal.timeout(this.#opts.timeoutMs) });
    } catch (err) {
      throw new OccBackendError(`OCC request failed: ${(err as Error).message}`);
    }
    if (res.status === 404) return undefined;
    if (!res.ok) throw new OccBackendError(`OCC ${path} returned ${res.status}`, res.status);
    return (await res.json()) as T;
  }
}

const STOCK: Record<NonNullable<OccProduct["stock"]>["stockLevelStatus"], StockStatus> = {
  inStock: "in_stock",
  lowStock: "low_stock",
  outOfStock: "out_of_stock",
};

function toCatalogProduct(p: OccProduct): CatalogProduct {
  const price = p.price!;
  const product: CatalogProduct = {
    id: p.code,
    title: p.name,
    description: stripHtml(p.description ?? p.summary ?? p.name),
    categories: (p.categories ?? []).map((c) => c.name ?? c.code),
    price: { amount: toMinorUnits(price.value, price.currencyIso), currency: price.currencyIso },
    stock: { status: STOCK[p.stock?.stockLevelStatus ?? "outOfStock"] },
  };
  if (p.url) product.url = p.url;
  if (p.stock?.stockLevel !== undefined) product.stock.quantity = p.stock.stockLevel;
  if (p.minOrderQuantity) product.orderRules = { minQuantity: p.minOrderQuantity };
  if (p.volumePrices?.length) {
    product.priceTiers = p.volumePrices
      .map((v): PriceTier => ({ minQuantity: v.minQuantity, unitPrice: { amount: toMinorUnits(v.value, v.currencyIso), currency: v.currencyIso } }))
      .sort((a, b) => a.minQuantity - b.minQuantity);
  }
  return product;
}

// OCC descriptions are HTML authored in Backoffice; agents get plain text.
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
