// ULIDs: 128-bit ids that sort by creation time (48-bit millisecond
// timestamp + 80 random bits), written in Crockford base32. Public ids are
// prefixed by type, Stripe-style: "alert_01JA5Q3M7W8X9Y0Z1A2B3C4D5E".
// Unlike SERIAL ids they don't reveal how many alerts exist and can't be
// enumerated, but unlike UUIDv4 they still sort chronologically.
// Uses Web Crypto, so this works in Node and in the browser.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()) {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[bytes[i] % 32];
  return time + random;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const newAlertId = () => `alert_${ulid()}`;

// Decodes the millisecond timestamp back out of a ULID.
export function ulidTime(id: string) {
  return id
    .slice(0, 10)
    .split("")
    .reduce((acc, ch) => acc * 32 + ALPHABET.indexOf(ch), 0);
}
