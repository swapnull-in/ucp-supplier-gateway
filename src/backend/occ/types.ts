// The subset of SAP Commerce OCC v2 response shapes the gateway consumes.
// Field names follow the OCC v2 product search response (fields=FULL); they still need
// checking against a real 2205 system (see "Open design questions" in README).

export interface OccPrice {
  currencyIso: string;
  value: number;
  priceType?: "BUY" | "FROM";
  formattedValue?: string;
}

export interface OccProduct {
  code: string;
  name: string;
  summary?: string;
  description?: string;
  url?: string;
  price?: OccPrice;
  stock?: { stockLevelStatus: "inStock" | "lowStock" | "outOfStock"; stockLevel?: number };
  categories?: { code: string; name?: string }[];
  minOrderQuantity?: number;
  /** B2B volume prices; returned on product detail with fields=FULL. */
  volumePrices?: (OccPrice & { minQuantity: number; maxQuantity?: number })[];
}

export interface OccProductSearchPage {
  products?: OccProduct[];
  pagination?: { currentPage: number; pageSize: number; totalResults: number };
}
