import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature v2 (vendored from shared/upgrade/signature.ts).
 * Signed payload is `${timestamp}.${nonce}.${rawBody}`.
 */

export const SIG_HEADER = "x-acp-signature";
export const TS_HEADER = "x-acp-timestamp";
export const NONCE_HEADER = "x-acp-nonce";
export const PROTOCOL_HEADER = "x-acp-protocol";
export const PROTOCOL_VERSION = "1";

/** Reject anything older/newer than this (seconds). */
export const MAX_SKEW_SECONDS = 300;

export interface SignedHeaders {
  [SIG_HEADER]: string;
  [TS_HEADER]: string;
  [NONCE_HEADER]: string;
  [PROTOCOL_HEADER]: string;
  "content-type": "application/json";
}

export function signPayload(
  secret: string,
  rawBody: string,
  opts: { timestamp?: number; nonce?: string } = {},
): { headers: SignedHeaders; timestamp: number; nonce: string; signature: string } {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomUUID();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest("hex");

  return {
    timestamp,
    nonce,
    signature,
    headers: {
      [SIG_HEADER]: signature,
      [TS_HEADER]: String(timestamp),
      [NONCE_HEADER]: nonce,
      [PROTOCOL_HEADER]: PROTOCOL_VERSION,
      "content-type": "application/json",
    },
  };
}

export type VerifyFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "stale_timestamp"
  | "replayed_nonce"
  | "bad_signature";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  nonce?: string;
}

export function verifySignature(params: {
  secrets: (string | null | undefined)[];
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  now?: number;
  seenNonce?: (nonce: string) => boolean;
}): VerifyResult {
  const header = (k: string): string | undefined => {
    const v = params.headers[k] ?? params.headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const signature = header(SIG_HEADER);
  const tsRaw = header(TS_HEADER);
  const nonce = header(NONCE_HEADER);
  if (!signature || !tsRaw || !nonce) return { ok: false, reason: "missing_headers" };

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };

  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  if (params.seenNonce?.(nonce)) return { ok: false, reason: "replayed_nonce" };

  const expectedBuf = Buffer.from(signature, "hex");
  for (const secret of params.secrets) {
    if (!secret) continue;
    const candidate = createHmac("sha256", secret)
      .update(`${ts}.${nonce}.${params.rawBody}`)
      .digest();
    if (candidate.length === expectedBuf.length && timingSafeEqual(candidate, expectedBuf)) {
      return { ok: true, nonce };
    }
  }
  return { ok: false, reason: "bad_signature" };
}

/** Bounded LRU of recently-seen nonces. */
export class NonceCache {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(private max = 1000) {}

  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  add(nonce: string): void {
    if (this.seen.has(nonce)) return;
    this.seen.add(nonce);
    this.order.push(nonce);
    while (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }
}
