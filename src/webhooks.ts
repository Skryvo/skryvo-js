import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./errors.js";
import type { WebhookEvent } from "./generated/schemas.js";

export interface VerifyOptions {
  /** Oldest signature accepted, in seconds; guards against a replayed delivery. */
  toleranceSeconds?: number;
  /** Unix seconds; for tests. */
  now?: number;
}

function parts(header: string): { t: number; v1: string[] } {
  let t = NaN;
  const v1: string[] = [];
  for (const piece of header.split(",")) {
    const [key, ...rest] = piece.trim().split("=");
    const value = rest.join("=");
    if (key === "t") t = Number(value);
    if (key === "v1" && value) v1.push(value);
  }
  return { t, v1 };
}

/** The hex HMAC-SHA256 Skryvo puts in `v1=`: of "<t>.<raw body>" with the endpoint's secret. */
export function sign(payload: string | Uint8Array, secret: string, timestamp: number): string {
  const body = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Checks a delivery's `Skryvo-Signature` header against the raw request body and returns the event.
 * Pass the body exactly as received, before any JSON parsing.
 */
export function verifyWebhook(
  payload: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): WebhookEvent {
  if (!signatureHeader) throw new WebhookVerificationError("The delivery has no Skryvo-Signature header.");
  if (!secret) throw new WebhookVerificationError("Pass the endpoint's secret (whsec_…).");
  const { t, v1 } = parts(signatureHeader);
  if (!Number.isFinite(t) || v1.length === 0) {
    throw new WebhookVerificationError("The Skryvo-Signature header is not in the form t=…,v1=….");
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) {
    throw new WebhookVerificationError(`The signature is older than ${tolerance} seconds.`);
  }
  const expected = Buffer.from(sign(payload, secret, t), "hex");
  const matches = v1.some((candidate) => {
    const given = Buffer.from(candidate, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new WebhookVerificationError("The signature doesn't match this endpoint's secret.");
  const body = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  try {
    return JSON.parse(body) as WebhookEvent;
  } catch (cause) {
    throw new WebhookVerificationError("The delivery's body is not JSON.", { cause });
  }
}
