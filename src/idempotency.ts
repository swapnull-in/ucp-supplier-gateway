import { createHash } from "node:crypto";

// UCP replay protection (signatures.md, "Replay Protection"): duplicate key + identical raw
// body returns the stored response; duplicate key + different body is a 409; keys are kept
// at least 24h (48h recommended); if the store fails, requests fail closed with 503.

export const IDEMPOTENCY_TTL_MS = 48 * 3600_000;

export type BeginResult =
  | { state: "new" }
  | { state: "replay"; statusCode: number; body: unknown }
  | { state: "conflict" }
  | { state: "in_flight" };

export interface IdempotencyStore {
  /** Atomically claims `key` within `scope` for a request whose raw body hashes to `fingerprint`. */
  begin(scope: string, key: string, fingerprint: string): Promise<BeginResult>;
  complete(scope: string, key: string, statusCode: number, body: unknown): Promise<void>;
  /** Releases a claim without storing a result, so the client can retry (e.g. after a 5xx). */
  release(scope: string, key: string): Promise<void>;
}

export function fingerprint(rawBody: Buffer | string): string {
  return createHash("sha256").update(rawBody).digest("base64");
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  result?: { statusCode: number; body: unknown };
}

/** Single-process store for the demo; production needs Postgres with a unique (scope, key) row. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async begin(scope: string, key: string, fp: string): Promise<BeginResult> {
    if (this.#entries.size > 10_000) this.#sweep();
    const id = `${scope}\u0000${key}`;
    const existing = this.#entries.get(id);
    if (existing && existing.expiresAt > this.now()) {
      if (existing.fingerprint !== fp) return { state: "conflict" };
      if (!existing.result) return { state: "in_flight" };
      return { state: "replay", ...existing.result };
    }
    this.#entries.set(id, { fingerprint: fp, expiresAt: this.now() + IDEMPOTENCY_TTL_MS });
    return { state: "new" };
  }

  async complete(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    const entry = this.#entries.get(`${scope}\u0000${key}`);
    if (entry) entry.result = { statusCode, body };
  }

  async release(scope: string, key: string): Promise<void> {
    this.#entries.delete(`${scope}\u0000${key}`);
  }

  #sweep() {
    const now = this.now();
    for (const [id, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(id);
  }
}
