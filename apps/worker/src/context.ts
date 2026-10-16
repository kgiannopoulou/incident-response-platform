import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import nodemailer from "nodemailer";
import type { RealtimeEvent } from "@irp/shared";
import { publishRealtime } from "@irp/shared/realtime";
import type { PostmortemDrafter } from "./ai-drafter";

export type WorkerContext = {
  pool: Pool;
  redis: Redis; // publisher
  notificationsQueue: Queue;
  escalationsQueue: Queue;
  webhooksQueue: Queue;
  deadLetterQueue: Queue;
  aiDraftsQueue: Queue;
  email: EmailSender;
  // Writes AI postmortem drafts (Claude, or offline rules without a key).
  drafter: PostmortemDrafter;
  // Links in emails and webhook payloads point here.
  webOrigin: string;
  // Refuse webhook URLs that resolve to private / loopback addresses (SSRF
  // protection). Off in local development, where receivers run on localhost.
  blockPrivateWebhookTargets: boolean;
};

export type EmailMessage = {
  to: { name: string; email: string };
  subject: string;
  text: string;
  html: string;
  // Fixed per notification row (see pageMessageId), so a page re-sent after
  // a crash has the same Message-ID as the first copy.
  messageId?: string;
};

// How a page leaves the system. Returns the provider's message id.
export type EmailSender = (message: EmailMessage) => Promise<{ messageId: string | null }>;

// SMTP when SMTP_URL is set — locally that's Mailpit from docker compose
// (smtp://localhost:1025, inbox at http://localhost:8025) — otherwise the
// email is only logged, so the whole flow works with no accounts at all.
export function createEmailSender(smtpUrl: string | undefined, from: string): EmailSender {
  if (!smtpUrl) {
    return async ({ to, subject }) => {
      console.log(`[email] (no SMTP_URL, not sent) -> ${to.name} <${to.email}>: ${subject}`);
      return { messageId: null };
    };
  }
  const transport = nodemailer.createTransport(smtpUrl);
  return async ({ to, subject, text, html, messageId }) => {
    const info = await transport.sendMail({ from, to: { name: to.name, address: to.email }, subject, text, html, messageId });
    return { messageId: info.messageId ?? null };
  };
}

export async function publish(ctx: Pick<WorkerContext, "redis">, organizationId: number, event: RealtimeEvent) {
  await publishRealtime(ctx.redis, organizationId, event).catch((err) => {
    console.error("Realtime publish failed:", err);
  });
}
