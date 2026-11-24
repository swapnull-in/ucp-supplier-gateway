import { randomUUID } from "node:crypto";
import type { ExternalQuote } from "./quote.js";

/**
 * Quotations the Business issued outside any cart, e.g. by a sales desk or a CPQ system,
 * which a Buyer later accepts on a cart by `accepted_id` (#929 §4).
 */
export interface QuoteBook {
  issue(quote: Omit<ExternalQuote, "id">): Promise<ExternalQuote>;
  get(id: string): Promise<ExternalQuote | undefined>;
}

/** Single-process store for the demo; production would read from the CPQ or ERP quote records. */
export class InMemoryQuoteBook implements QuoteBook {
  readonly #quotes = new Map<string, ExternalQuote>();

  async issue(quote: Omit<ExternalQuote, "id">): Promise<ExternalQuote> {
    const issued = { ...quote, id: `qt_${randomUUID()}` };
    this.#quotes.set(issued.id, issued);
    return issued;
  }

  async get(id: string): Promise<ExternalQuote | undefined> {
    return this.#quotes.get(id);
  }
}
