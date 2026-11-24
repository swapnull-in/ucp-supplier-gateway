// Canonical catalog model shared by all protocol adapters (UCP, ACP) and all
// commerce backends (SAP OCC, ...). Money is always integer minor units.

export interface Money {
  amount: number;
  currency: string;
}

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface CatalogProduct {
  id: string;
  title: string;
  description: string;
  url?: string;
  categories: string[];
  /** Price for the requesting buyer account, or the public price if anonymous. */
  price: Money;
  /** Public list price, present when the account price differs from it. */
  listPrice?: Money;
  stock: { status: StockStatus; quantity?: number };
  /** Minimum order quantity and ordering increment, common in B2B catalogs. */
  orderRules?: { minQuantity?: number; increment?: number };
  /** Volume price breaks for this account, ascending by minQuantity. */
  priceTiers?: PriceTier[];
}

export interface PriceTier {
  minQuantity: number;
  unitPrice: Money;
}

/** The buyer organisation a request is made for, resolved from identity linking. */
export interface BuyerAccount {
  /** Backend identifier, e.g. an SAP B2B unit id. */
  id: string;
  name: string;
}

export interface SearchQuery {
  text: string;
  limit: number;
  account?: BuyerAccount;
}

export interface CommerceBackend {
  searchProducts(query: SearchQuery): Promise<CatalogProduct[]>;
  /** Fetches products by id; ids that don't exist are omitted from the result. */
  getProducts(ids: string[], account?: BuyerAccount): Promise<CatalogProduct[]>;
}
