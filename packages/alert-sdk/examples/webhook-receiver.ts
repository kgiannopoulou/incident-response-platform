// A minimal receiver for Fireline's outgoing webhooks: verifies the
// signature on the raw body, rejects replays, and ignores duplicate
// deliveries (they're at-least-once).
//
//   FIRELINE_WEBHOOK_SECRET=whsec_… npm run example:webhooks -w @incident-platform/sdk
//
// Then register http://localhost:4100/fireline under Webhooks in the app
// (with WEBHOOK_BLOCK_PRIVATE_NETWORKS=false, the local default) and press
// "Send test".
import http from "node:http";
import { constructWebhookEvent, SIGNATURE_HEADER, WebhookSignatureError } from "@incident-platform/sdk";

const secret = process.env.FIRELINE_WEBHOOK_SECRET;
if (!secret) throw new Error("Set FIRELINE_WEBHOOK_SECRET to the endpoint's signing secret (whsec_…)");
const port = Number(process.env.PORT ?? 4100);

// In production this would be a table / Redis set with a TTL.
const seen = new Set<string>();

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/fireline") return res.writeHead(404).end();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) req.destroy(); // payloads are a few hundred bytes
      chunks.push(chunk);
    });
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      try {
        const event = await constructWebhookEvent(secret, rawBody, req.headers[SIGNATURE_HEADER] as string | undefined);
        if (seen.has(event.id)) {
          console.log(`duplicate ${event.id} ignored`);
          return res.writeHead(200).end();
        }
        seen.add(event.id);
        console.log(`${event.event} ${event.incident?.id ?? ""} ${event.incident?.title ?? ""}`.trim());
        res.writeHead(204).end();
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          console.warn(`rejected: ${err.message}`);
          return res.writeHead(401).end();
        }
        res.writeHead(400).end();
      }
    });
  })
  .listen(port, () => console.log(`Listening for Fireline webhooks on http://localhost:${port}/fireline`));
