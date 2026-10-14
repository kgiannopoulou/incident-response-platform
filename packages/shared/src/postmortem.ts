import { INCIDENT_SEVERITY_LABEL, incidentRef, type IncidentSeverity } from "./domain";
import type { ActionItem } from "./schemas";

// Builds a postmortem *draft* from what the platform already knows: the
// incident record, its alerts and its timeline. Responders then edit the
// narrative sections (root cause especially) in the UI. Pure function, so
// the wording and metrics are unit tested.

export type PostmortemInput = {
  incident: {
    number: number;
    title: string;
    severity: IncidentSeverity;
    serviceName: string | null;
    triggeredAt: Date;
    acknowledgedAt: Date | null;
    mitigatedAt?: Date | null;
    resolvedAt: Date | null;
  };
  alerts: { title: string; severity: string; source: string; receivedAt: Date }[];
  timeline: { type: string; message: string; actorName: string | null; createdAt: Date }[];
  responders: { name: string; role: string }[];
};

export type PostmortemMetrics = {
  timeToAcknowledgeSeconds: number | null;
  // Customer impact window: until mitigation, or until resolution when the
  // incident was never marked mitigated.
  timeToMitigateSeconds: number | null;
  timeToResolveSeconds: number | null;
  alertCount: number;
  escalations: number;
  notesCount: number;
  responderCount: number;
};

export type PostmortemDraft = {
  summary: string;
  impact: string;
  rootCause: string;
  resolution: string;
  actionItems: ActionItem[];
  metrics: PostmortemMetrics;
  timelineMarkdown: string;
};

const seconds = (from: Date, to: Date | null) =>
  to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000)) : null;

export function formatDuration(totalSeconds: number | null) {
  if (totalSeconds === null) return "n/a";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16) + " UTC";

export function buildPostmortemDraft(input: PostmortemInput): PostmortemDraft {
  const { incident, alerts, timeline, responders } = input;
  const ref = incidentRef(incident.number);
  const metrics: PostmortemMetrics = {
    timeToAcknowledgeSeconds: seconds(incident.triggeredAt, incident.acknowledgedAt),
    timeToMitigateSeconds: seconds(incident.triggeredAt, incident.mitigatedAt ?? incident.resolvedAt),
    timeToResolveSeconds: seconds(incident.triggeredAt, incident.resolvedAt),
    alertCount: alerts.length,
    escalations: timeline.filter((e) => e.type === "escalated").length,
    notesCount: timeline.filter((e) => e.type === "note").length,
    responderCount: responders.length,
  };

  const service = incident.serviceName ?? "an unassigned service";
  const summary =
    `${ref} (${INCIDENT_SEVERITY_LABEL[incident.severity]}) affected ${service}: ${incident.title}. ` +
    `It was opened on ${incident.triggeredAt.toISOString().slice(0, 10)} at ${hhmm(incident.triggeredAt)}` +
    (incident.resolvedAt
      ? ` and resolved after ${formatDuration(metrics.timeToResolveSeconds)}.`
      : " and is not resolved yet.");

  const firstAlert = [...alerts].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())[0];
  const sources = [...new Set(alerts.map((a) => a.source))];
  const impact =
    `${service} was impacted for ${formatDuration(metrics.timeToMitigateSeconds)}` +
    (incident.mitigatedAt && incident.resolvedAt && incident.mitigatedAt < incident.resolvedAt
      ? ` (mitigated, then fully resolved after ${formatDuration(metrics.timeToResolveSeconds)}). `
      : ". ") +
    `${alerts.length} alert${alerts.length === 1 ? "" : "s"} fired` +
    (sources.length ? ` from ${sources.join(", ")}` : "") +
    ". Describe the customer-facing impact here (affected users, failed requests, revenue).";

  const rootCause = firstAlert
    ? `First signal: "${firstAlert.title}" from ${firstAlert.source} at ${hhmm(firstAlert.receivedAt)}. ` +
      "Replace this with the confirmed root cause and the contributing factors."
    : "Describe the confirmed root cause and the contributing factors.";

  const resolvedEvent = [...timeline].reverse().find((e) => e.type === "resolved");
  const resolution = resolvedEvent
    ? `${resolvedEvent.message}${resolvedEvent.actorName ? ` (${resolvedEvent.actorName})` : ""}`
    : "Describe how the incident was mitigated and resolved.";

  const actionItems: ActionItem[] = [
    { description: "Confirm the root cause and document it in this postmortem", owner: "", done: false },
  ];
  if (metrics.escalations > 0) {
    actionItems.push({
      description: `Review on-call coverage: the incident escalated ${metrics.escalations} time(s) before anyone acknowledged it`,
      owner: "",
      done: false,
    });
  }
  if (metrics.timeToAcknowledgeSeconds !== null && metrics.timeToAcknowledgeSeconds > 15 * 60) {
    actionItems.push({
      description: `Time to acknowledge was ${formatDuration(metrics.timeToAcknowledgeSeconds)} — check paging/notification settings`,
      owner: "",
      done: false,
    });
  }
  if (alerts.length > 5) {
    actionItems.push({
      description: `${alerts.length} alerts fired for one problem — tune alert rules or dedup keys to reduce noise`,
      owner: "",
      done: false,
    });
  }
  if (alerts.length === 0) {
    actionItems.push({
      description: "No automated alert fired — add monitoring that would have detected this",
      owner: "",
      done: false,
    });
  }

  const timelineMarkdown = [...timeline]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((e) => `- **${hhmm(e.createdAt)}** — ${e.message}${e.actorName ? ` _(${e.actorName})_` : ""}`)
    .join("\n");

  return { summary, impact, rootCause, resolution, actionItems, metrics, timelineMarkdown };
}
