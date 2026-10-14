import { z } from "zod";
import { incidentRef, INCIDENT_SEVERITY_LABEL, type IncidentSeverity, type IncidentStatus } from "./domain";

// Outgoing webhooks: incident lifecycle events POSTed to URLs an admin
// registers. Browser-safe (no Node built-ins); signing lives in
// "@irp/shared/crypto".

export const WEBHOOK_EVENTS = [
  "incident.triggered",
  "incident.acknowledged",
  "incident.escalated",
  "incident.resolved",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
// Sent by "Send test" only; every endpoint receives it regardless of subscriptions.
export type WebhookDeliveryEvent = WebhookEvent | "ping";

export const WEBHOOK_SIGNATURE_HEADER = "Fireline-Signature";
export const WEBHOOK_EVENT_HEADER = "Fireline-Event";
export const WEBHOOK_DELIVERY_HEADER = "Fireline-Delivery";

// Plain-word severity for receivers that don't know SEV levels.
export const SEVERITY_NAME: Record<IncidentSeverity, "critical" | "major" | "minor" | "low"> = {
  sev1: "critical",
  sev2: "major",
  sev3: "minor",
  sev4: "low",
};

const webhookUrl = z
  .url({ protocol: /^https?$/, message: "must be an http(s) URL" })
  .max(2000);

export const createWebhookSchema = z.object({
  url: webhookUrl,
  description: z.string().trim().max(200).default(""),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).default([...WEBHOOK_EVENTS]),
});

export const updateWebhookSchema = z.object({
  url: webhookUrl.optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  enabled: z.boolean().optional(),
});

export type WebhookIncident = {
  number: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  serviceName: string | null;
  serviceSlug: string | null;
  escalationLevel: number;
  triggeredAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
};

export type WebhookPayload = {
  id: string; // unique per event; receivers dedupe on it (deliveries are at-least-once)
  event: WebhookDeliveryEvent;
  createdAt: string;
  incident?: {
    id: string; // "INC-142"
    number: number;
    title: string;
    severity: "critical" | "major" | "minor" | "low";
    severityLevel: IncidentSeverity;
    severityLabel: string;
    status: IncidentStatus;
    service: { name: string; slug: string } | null;
    escalationLevel: number;
    url: string;
    triggeredAt: string;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
  };
  actor?: string | null; // who acknowledged / resolved / escalated, when a person did
};

// The JSON body for one event. Built once, stored on the delivery row and
// sent byte-for-byte on every attempt.
export function buildWebhookPayload(
  event: WebhookDeliveryEvent,
  eventId: string,
  incident: WebhookIncident | null,
  { webOrigin, actor = null, now = new Date() }: { webOrigin: string; actor?: string | null; now?: Date }
): WebhookPayload {
  const payload: WebhookPayload = { id: eventId, event, createdAt: now.toISOString() };
  if (incident) {
    payload.incident = {
      id: incidentRef(incident.number),
      number: incident.number,
      title: incident.title,
      severity: SEVERITY_NAME[incident.severity],
      severityLevel: incident.severity,
      severityLabel: INCIDENT_SEVERITY_LABEL[incident.severity],
      status: incident.status,
      service: incident.serviceName && incident.serviceSlug ? { name: incident.serviceName, slug: incident.serviceSlug } : null,
      escalationLevel: incident.escalationLevel,
      url: `${webOrigin.replace(/\/$/, "")}/incidents/${incident.number}`,
      triggeredAt: incident.triggeredAt.toISOString(),
      acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    };
    payload.actor = actor;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Email pages
// ---------------------------------------------------------------------------

export type PageKind = "triggered" | "escalated" | "acknowledged" | "resolved";

const PAGE_VERB: Record<PageKind, string> = {
  triggered: "New incident",
  escalated: "ESCALATED — still unacknowledged",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// The email a responder receives when paged. Subject first, because that's
// what shows on a lock screen: "[SEV1 · Critical] New incident: INC-2 Checkout down (Checkout API)".
export function renderPageEmail(page: {
  kind: PageKind;
  recipientName: string;
  incident: { number: number; title: string; severity: IncidentSeverity; serviceName: string | null };
  escalationLevel: number | null;
  webOrigin: string;
}) {
  const { incident } = page;
  const ref = incidentRef(incident.number);
  const url = `${page.webOrigin.replace(/\/$/, "")}/incidents/${incident.number}`;
  const subject =
    `[${INCIDENT_SEVERITY_LABEL[incident.severity]}] ${PAGE_VERB[page.kind]}: ${ref} ` +
    `${incident.title}${incident.serviceName ? ` (${incident.serviceName})` : ""}`;
  const why =
    page.kind === "triggered" || page.kind === "escalated"
      ? `You are on escalation level ${page.escalationLevel ?? 1} for this service.`
      : `You were paged for this incident earlier.`;
  const action = page.kind === "triggered" || page.kind === "escalated" ? "Acknowledge or join" : "View";
  const text = [
    `Hi ${page.recipientName},`,
    "",
    `${PAGE_VERB[page.kind]}: ${ref} — ${incident.title}`,
    `Severity: ${INCIDENT_SEVERITY_LABEL[incident.severity]}`,
    `Service: ${incident.serviceName ?? "—"}`,
    "",
    why,
    `${action}: ${url}`,
    "",
    "— Fireline",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<p>Hi ${escapeHtml(page.recipientName)},</p>
<p style="font-size:18px;margin:16px 0"><strong>${escapeHtml(PAGE_VERB[page.kind])}: ${ref}</strong><br>${escapeHtml(incident.title)}</p>
<table style="font-size:14px;border-collapse:collapse">
<tr><td style="color:#666;padding-right:12px">Severity</td><td>${escapeHtml(INCIDENT_SEVERITY_LABEL[incident.severity])}</td></tr>
<tr><td style="color:#666;padding-right:12px">Service</td><td>${escapeHtml(incident.serviceName ?? "—")}</td></tr>
</table>
<p style="font-size:14px;color:#444">${escapeHtml(why)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#dc2626;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">${action} ${ref}</a></p>
<p style="font-size:12px;color:#888">— Fireline</p>
</div>`;
  return { subject, text, html };
}
