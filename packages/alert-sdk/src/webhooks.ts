// Verifying Fireline's outgoing webhooks on the receiving side.
//
// Every delivery carries
//
//   Fireline-Signature: t=1760430000,v1=5257a869e7ec…
//   Fireline-Delivery:  1234            (stable across retries)
//   Fireline-Event:     incident.triggered
//
// where v1 = hex(HMAC-SHA256(secret, `${t}.${rawBody}`)). Verify against the
// *raw* request body (before JSON parsing — re-serialising changes bytes),
// reject old timestamps (replays of a captured request), and dedupe on the
// payload `id`: deliveries are at-least-once.
//
// Uses Web Crypto (crypto.subtle), so it runs unchanged on Node 20+, Deno,
// Bun, Cloudflare Workers and other edge runtimes; HMAC verification there
// is constant-time.

export const SIGNATURE_HEADER = "fireline-signature";
export const DELIVERY_HEADER = "fireline-delivery";
export const EVENT_HEADER = "fireline-event";

export type FirelineWebhookEvent = {
  id: string; // "evt_…": unique per event, dedupe on it
  event: "incident.triggered" | "incident.acknowledged" | "incident.escalated" | "incident.resolved" | "ping";
  createdAt: string;
  incident?: {
    id: string; // "INC-142"
    number: number;
    title: string;
    severity: "critical" | "major" | "minor" | "low";
    severityLevel: "sev1" | "sev2" | "sev3" | "sev4";
    status: string;
    service: { name: string; slug: string } | null;
    escalationLevel: number;
    url: string;
    triggeredAt: string;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
  };
  actor?: string | null;
};

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export type VerifyOptions = {
  // Maximum age (or clock skew into the future) of the signature. Default 300 s.
  toleranceSeconds?: number;
  // Unix seconds; for tests.
  now?: number;
};

const encoder = new TextEncoder();

function hexToBytes(hex: string) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Throws WebhookSignatureError explaining what's wrong, or resolves when the
// signature is valid and fresh.
export async function assertValidWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) }: VerifyOptions = {}
): Promise<void> {
  if (!header) throw new WebhookSignatureError("Missing Fireline-Signature header");
  const parts = new Map(
    header.split(",").map((part) => {
      const i = part.indexOf("=");
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()] as const;
    })
  );
  const timestamp = Number(parts.get("t"));
  const signature = hexToBytes(parts.get("v1") ?? "");
  if (!Number.isInteger(timestamp) || !signature) throw new WebhookSignatureError("Malformed Fireline-Signature header");
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError(`Signature timestamp is outside the ${toleranceSeconds}s tolerance (possible replay)`);
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(`${timestamp}.${rawBody}`));
  if (!valid) throw new WebhookSignatureError("Signature does not match (wrong secret, or the body was modified)");
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  options?: VerifyOptions
): Promise<boolean> {
  try {
    await assertValidWebhookSignature(secret, rawBody, header, options);
    return true;
  } catch (err) {
    if (err instanceof WebhookSignatureError) return false;
    throw err;
  }
}

// Verify, then parse: the one call most receivers need.
//
//   const event = await constructWebhookEvent(process.env.FIRELINE_WEBHOOK_SECRET!, rawBody, req.headers["fireline-signature"]);
//   if (seen.has(event.id)) return res.status(200).end(); // duplicate delivery
export async function constructWebhookEvent(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  options?: VerifyOptions
): Promise<FirelineWebhookEvent> {
  await assertValidWebhookSignature(secret, rawBody, header, options);
  return JSON.parse(rawBody) as FirelineWebhookEvent;
}
