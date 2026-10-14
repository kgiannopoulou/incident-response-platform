import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WEBHOOK_DELIVERY_HEADER, WEBHOOK_EVENT_HEADER, WEBHOOK_SIGNATURE_HEADER } from "@irp/shared";
import { signWebhook } from "@irp/shared/crypto";
import type { WorkerContext } from "./context";

const TIMEOUT_MS = 10_000;

// Loopback, private (RFC 1918), link-local (incl. cloud metadata
// 169.254.169.254), CGNAT, unique-local IPv6 and unspecified addresses.
export function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicTarget(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw new Error(`Refusing to call a private address (${url.hostname})`);
}

class PermanentWebhookError extends Error {}

// Sends one webhook delivery: the stored payload, signed with the endpoint's
// secret. 2xx = sent. Anything else (or a timeout) is recorded and rethrown
// so BullMQ retries with backoff; after the last attempt the row is failed.
// A 410 Gone means "stop sending": the endpoint is disabled.
export async function deliverWebhook(ctx: WorkerContext, deliveryId: number, isFinalAttempt = true) {
  const { rows } = await ctx.pool.query(
    `SELECT d.id, d.status, d.event, d.payload, e.id AS endpoint_id, e.url, e.secret, e.enabled
     FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  const d = rows[0];
  if (!d || d.status !== "queued") return "skipped" as const;
  if (!d.enabled && d.event !== "ping") {
    await ctx.pool.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'Endpoint disabled' WHERE id = $1`, [deliveryId]);
    return "skipped" as const;
  }

  const body = JSON.stringify(d.payload);
  const started = Date.now();
  let status: number | null = null;
  try {
    const url = new URL(d.url);
    if (ctx.blockPrivateWebhookTargets) await assertPublicTarget(url);
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual", // a redirect to an internal address must not bypass the check above
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Fireline-Webhooks/1.0",
        [WEBHOOK_EVENT_HEADER]: d.event,
        [WEBHOOK_DELIVERY_HEADER]: String(d.id),
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(d.secret, body),
      },
      body,
    });
    status = res.status;
    await res.body?.cancel();
    if (status === 410) throw new PermanentWebhookError("Receiver answered 410 Gone; endpoint disabled");
    if (status < 200 || status >= 300) throw new Error(`Receiver answered HTTP ${status}`);
  } catch (err) {
    const permanent = err instanceof PermanentWebhookError;
    const message = (err as Error).name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s` : (err as Error).message;
    await ctx.pool.query(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2, response_status = $3, duration_ms = $4,
              status = CASE WHEN $5 THEN 'failed' ELSE status END
       WHERE id = $1`,
      [deliveryId, message, status, Date.now() - started, isFinalAttempt || permanent]
    );
    if (permanent) {
      await ctx.pool.query(`UPDATE webhook_endpoints SET enabled = false, disabled_reason = $2 WHERE id = $1`, [
        d.endpoint_id,
        message,
      ]);
      return "disabled" as const; // don't retry
    }
    throw new Error(message);
  }

  await ctx.pool.query(
    `UPDATE webhook_deliveries SET status = 'sent', delivered_at = now(), attempts = attempts + 1, last_error = NULL,
            response_status = $2, duration_ms = $3
     WHERE id = $1 AND status = 'queued'`,
    [deliveryId, status, Date.now() - started]
  );
  return "sent" as const;
}
