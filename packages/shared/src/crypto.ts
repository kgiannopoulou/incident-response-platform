import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Server-only (node:crypto): exported as "@irp/shared/crypto", not from the
// browser-safe index.

export const API_KEY_PREFIX = "ir_live_";

// 192 bits of randomness, hex-encoded: "ir_live_a8f83e7c…" (56 chars).
// The recognisable prefix lets secret scanners (GitHub, gitleaks) flag
// leaked keys and lets people tell an API key from other tokens at a glance.
export function generateApiKey() {
  return API_KEY_PREFIX + randomBytes(24).toString("hex");
}

// What we keep to identify a key in UIs and logs: enough to tell keys
// apart, far too little to use. "ir_live_a8f83e7c"
export const apiKeyDisplayPrefix = (key: string) => key.slice(0, API_KEY_PREFIX.length + 8);

// Keys are long random secrets, not human passwords, so a fast hash is the
// right tool: there is nothing to brute-force that a slow KDF (bcrypt,
// argon2) would protect, and a deterministic hash allows an indexed lookup
// (WHERE key_hash = $1) on every request. Only this hash is stored.
export function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

// ---------------------------------------------------------------------------
// Webhook signing (Stripe-style). Each request carries
//
//   Fireline-Signature: t=1760430000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
//
// where v1 = hex(HMAC-SHA256(secret, `${t}.${body}`)). Signing the timestamp
// with the body lets receivers reject replays of an old, captured request.
// ---------------------------------------------------------------------------

export const generateWebhookSecret = () => "whsec_" + randomBytes(24).toString("hex");

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

// What a receiver does. Constant-time comparison; rejects signatures older
// (or further in the future) than `toleranceSeconds`.
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = {}
) {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, body, timestamp).split("v1=")[1], "hex");
  const actual = Buffer.from(parts.v1, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
