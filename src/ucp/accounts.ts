import type { BuyerAccount } from "../backend/types.js";

export const SCOPE_CATALOG_SEARCH = "dev.ucp.shopping.catalog.search:read";
export const SCOPE_CATALOG_LOOKUP = "dev.ucp.shopping.catalog.lookup:read";
export const SCOPE_CART_MANAGE = "dev.ucp.shopping.cart:manage";

export interface AccountGrant {
  account: BuyerAccount;
  scopes: string[];
}

/**
 * Resolves the bearer token a platform obtained through UCP identity linking to the buyer
 * organisation it represents. v0 uses a static token table; the production path is an
 * OAuth 2.0 authorization server implementing UCP identity linking.
 */
export interface AccountResolver {
  resolve(bearerToken: string): Promise<AccountGrant | undefined>;
}

export class StaticAccountResolver implements AccountResolver {
  constructor(private readonly grants: Record<string, AccountGrant>) {}

  async resolve(bearerToken: string): Promise<AccountGrant | undefined> {
    return Object.hasOwn(this.grants, bearerToken) ? this.grants[bearerToken] : undefined;
  }
}
