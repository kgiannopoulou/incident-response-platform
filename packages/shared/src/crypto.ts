import { createHash, randomBytes } from "node:crypto";

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
