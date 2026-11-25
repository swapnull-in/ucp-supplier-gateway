import { TERMS_CAPABILITY } from "./checkout.js";
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
        "dev.ucp.shopping.checkout": [
          { version: UCP_VERSION, spec: `${SPEC}/shopping/checkout`, schema: `${SCHEMAS}/shopping/checkout.json` },
        ],
        "dev.ucp.shopping.order": [
          { version: UCP_VERSION, spec: `${SPEC}/shopping/order`, schema: `${SCHEMAS}/shopping/order.json` },
        ],
        [TERMS_CAPABILITY]: [
          {
            version: UCP_VERSION,
            spec: `${SPEC}/payment/extensions/terms`,
            schema: `${SCHEMAS}/common/payment_terms.json`,
            extends: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.order"],
          },
        ],
        [quoteCapability]: [
          {
            version: UCP_VERSION,
            spec: "https://github.com/Universal-Commerce-Protocol/ucp/issues/929",
            schema: quoteSchemaUrl,
            extends: ["dev.ucp.shopping.cart", "dev.ucp.shopping.checkout", "dev.ucp.shopping.order"],
          },
        ],
      },
      // Account buyers pay on invoice under payment terms, so no payment handlers are offered.
      payment_handlers: {},
    },
  };
}
