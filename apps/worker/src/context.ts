import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { orgChannel, type RealtimeEvent } from "@irp/shared";

export type WorkerContext = {
  pool: Pool;
  redis: Redis; // publisher
  notificationsQueue: Queue;
  escalationsQueue: Queue;
  sender: NotificationSender;
};

// How a page actually leaves the system. The default posts to a
// Slack-compatible webhook when NOTIFY_WEBHOOK_URL is set and otherwise just
// logs, so the whole flow works locally with no external accounts.
export type NotificationSender = (message: { to: { name: string; email: string }; text: string }) => Promise<void>;

export function createSender(webhookUrl: string | undefined): NotificationSender {
  return async ({ to, text }) => {
    if (!webhookUrl) {
      console.log(`[notify] -> ${to.name} <${to.email}>: ${text}`);
      return;
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `@${to.name}: ${text}` }),
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  };
}

export async function publish(ctx: Pick<WorkerContext, "redis">, organizationId: number, event: RealtimeEvent) {
  await ctx.redis.publish(orgChannel(organizationId), JSON.stringify(event)).catch((err) => {
    console.error("Realtime publish failed:", err);
  });
}
