import { UCP_VERSION } from "./schemas.js";

export interface ProfileOptions {
  /** Public origin of the gateway, without trailing slash. */
  publicOrigin: string;
  /** Path prefix of the UCP shopping service. */
  shoppingBase: string;
  /** Name of the quote extension capability (vendor-namespaced until #929 is released). */
  quoteCapability: string;
  quoteSchemaUrl: string;
}

const SPEC = `https://ucp.dev/${UCP_VERSION}/specification`;
const SCHEMAS = `https://ucp.dev/${UCP_VERSION}/schemas`;

/** The business profile served at /.well-known/ucp. */
export function businessProfile({ publicOrigin, shoppingBase, quoteCapability, quoteSchemaUrl }: ProfileOptions) {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [
          {
            version: UCP_VERSION,
            spec: `${SPEC}/overview`,
            transport: "rest",
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/rest.openapi.json`,
            endpoint: `${publicOrigin}${shoppingBase}`,
          },
          {
            version: UCP_VERSION,
            spec: `${SPEC}/overview`,
            transport: "mcp",
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
            endpoint: `${publicOrigin}${shoppingBase}/mcp`,
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.catalog.search": [
          { version: UCP_VERSION, spec: `${SPEC}/shopping/catalog/search`, schema: `${SCHEMAS}/shopping/catalog_search.json` },
        ],
        "dev.ucp.shopping.catalog.lookup": [
          { version: UCP_VERSION, spec: `${SPEC}/shopping/catalog/lookup`, schema: `${SCHEMAS}/shopping/catalog_lookup.json` },
        ],
        "dev.ucp.shopping.cart": [
          { version: UCP_VERSION, spec: `${SPEC}/shopping/cart`, schema: `${SCHEMAS}/shopping/cart.json` },
        ],
        [quoteCapability]: [
          {
            version: UCP_VERSION,
            spec: "https://github.com/Universal-Commerce-Protocol/ucp/issues/929",
            schema: quoteSchemaUrl,
            extends: "dev.ucp.shopping.cart",
          },
        ],
      },
      // Checkout isn't offered yet, so there is nothing to pay with.
      payment_handlers: {},
    },
  };
}
