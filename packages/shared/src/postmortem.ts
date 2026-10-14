import { INCIDENT_SEVERITY_LABEL, incidentRef, type IncidentSeverity } from "./domain";
import type { ActionItem } from "./schemas";

// Builds a postmortem *draft* from what the platform already knows: the
// incident record, its alerts and — above all — its immutable timeline.
// Responders then edit the narrative sections (root cause especially) in
// the UI. Pure functions, so the wording, metrics and the curated timeline
// are unit tested.
//
//   INC-142 POSTMORTEM
//   Incident   Checkout API unavailable
//   Duration   37 minutes          Severity  SEV-1
//   Impact     ...
//   Timeline   14:02 Incident detected / 14:03 acknowledged / ...   ← from timeline_events
//   Root cause / Resolution / What went well / What went poorly
//   Action items  ☐ Add DB connection alerts ...

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
    ackTimedOutAt?: Date | null;
  };
  alerts: { title: string; severity: string; source: string; receivedAt: Date }[];
  // The incident's immutable timeline, in insertion order. `id` and `hash`
  // tie each postmortem timeline entry back to its audit-log row.
  timeline: { id?: number; hash?: string | null; type: string; message: string; actorName: string | null; createdAt: Date }[];
  responders: { name: string; role: string }[];
};

export type PostmortemMetrics = {
  durationSeconds: number | null; // triggered → resolved
  timeToAcknowledgeSeconds: number | null;
  // Customer impact window: until mitigation, or until resolution when the
  // incident was never marked mitigated.
  timeToMitigateSeconds: number | null;
  timeToResolveSeconds: number | null;
  alertCount: number;
  escalations: number;
  ackTimeouts: number;
  notesCount: number;
  responderCount: number;
};

// One line of the postmortem timeline. Times and messages come from the
// audit log and are never edited; responders can only hide an entry from
// the document (and the export) — the underlying event stays.
export type PostmortemTimelineEntry = {
  eventId: number | null;
  hash: string | null; // the event's hash-chain link, so an entry can be checked against the log
  at: string; // ISO
  type: string;
  message: string;
  actor: string | null;
  hidden: boolean;
};

export type PostmortemDraft = {
  summary: string;
  impact: string;
  rootCause: string;
  resolution: string;
  whatWentWell: string;
  whatWentPoorly: string;
  actionItems: ActionItem[];
  metrics: PostmortemMetrics;
  timeline: PostmortemTimelineEntry[];
};

const seconds = (from: Date, to: Date | null | undefined) =>
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

// "37 minutes", "1 hour 5 minutes", "45 seconds" — for the document header.
export function formatDurationLong(totalSeconds: number | null) {
  if (totalSeconds === null) return "ongoing";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (totalSeconds < 60) return plural(totalSeconds, "second");
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? plural(h, "hour") : "", m || !h ? plural(m, "minute") : ""].filter(Boolean).join(" ");
}

// "SEV1" -> "SEV-1", the way postmortem templates usually write it.
export const sevLabel = (severity: IncidentSeverity) => severity.toUpperCase().replace("SEV", "SEV-");

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

export const newActionItemId = () => `ai_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

// Event types that tell the story. Housekeeping (postmortem generated,
// people joining) is left out; repeated alerts are collapsed.
const STORY_EVENTS = new Set([
  "INCIDENT_CREATED",
  "NOTIFICATION_SENT",
  "INCIDENT_ESCALATED",
  "ACK_TIMEOUT",
  "INCIDENT_ACKNOWLEDGED",
  "COMMANDER_ASSIGNED",
  "STATUS_CHANGED",
  "SEVERITY_CHANGED",
  "NOTE_ADDED",
  "ALERT_RESOLVED",
  "INCIDENT_RESOLVED",
]);

// Turns the immutable event log into the postmortem timeline: story events
// in order, with each run of consecutive ALERT_ATTACHED events collapsed
// into one entry ("3 more alerts grouped into the incident") so a noisy
// alert storm doesn't bury the human decisions.
export function curateTimeline(events: PostmortemInput["timeline"]): PostmortemTimelineEntry[] {
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id ?? 0) - (b.id ?? 0));
  const entries: PostmortemTimelineEntry[] = [];
  let run: PostmortemInput["timeline"] = [];
  const flushRun = () => {
    if (!run.length) return;
    const [first] = run;
    entries.push({
      eventId: first.id ?? null,
      hash: first.hash ?? null,
      at: first.createdAt.toISOString(),
      type: "ALERT_ATTACHED",
      message: run.length === 1 ? first.message : `${run.length} more alerts grouped into the incident (first: ${first.message.replace(/^Alert grouped: /, "")})`,
      actor: null,
      hidden: false,
    });
    run = [];
  };
  for (const e of sorted) {
    if (e.type === "ALERT_ATTACHED") {
      run.push(e);
      continue;
    }
    flushRun();
    if (!STORY_EVENTS.has(e.type)) continue;
    entries.push({
      eventId: e.id ?? null,
      hash: e.hash ?? null,
      at: e.createdAt.toISOString(),
      type: e.type,
      message: e.message,
      actor: e.actorName,
      hidden: false,
    });
  }
  flushRun();
  return entries;
}

// Keeps responders' "hide this entry" choices when the timeline is rebuilt
// (Refresh data) — matched by the source event id.
export function mergeTimelineVisibility(fresh: PostmortemTimelineEntry[], previous: PostmortemTimelineEntry[]) {
  const hidden = new Set(previous.filter((e) => e.hidden && e.eventId !== null).map((e) => e.eventId));
  return fresh.map((e) => (e.eventId !== null && hidden.has(e.eventId) ? { ...e, hidden: true } : e));
}

export function buildPostmortemDraft(input: PostmortemInput): PostmortemDraft {
  const { incident, alerts, timeline, responders } = input;
  const ref = incidentRef(incident.number);
  const metrics: PostmortemMetrics = {
    durationSeconds: seconds(incident.triggeredAt, incident.resolvedAt),
    timeToAcknowledgeSeconds: seconds(incident.triggeredAt, incident.acknowledgedAt),
    timeToMitigateSeconds: seconds(incident.triggeredAt, incident.mitigatedAt ?? incident.resolvedAt),
    timeToResolveSeconds: seconds(incident.triggeredAt, incident.resolvedAt),
    alertCount: alerts.length,
    escalations: timeline.filter((e) => e.type === "INCIDENT_ESCALATED").length,
    ackTimeouts: timeline.filter((e) => e.type === "ACK_TIMEOUT").length,
    notesCount: timeline.filter((e) => e.type === "NOTE_ADDED").length,
    responderCount: responders.filter((r) => r.role !== "observer").length, // observers watched, didn't respond
  };

  const service = incident.serviceName ?? "an unassigned service";
  const summary =
    `${ref} (${INCIDENT_SEVERITY_LABEL[incident.severity]}) affected ${service}: ${incident.title}. ` +
    `It was opened on ${incident.triggeredAt.toISOString().slice(0, 10)} at ${hhmm(incident.triggeredAt)} UTC` +
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
    ? `First signal: "${firstAlert.title}" from ${firstAlert.source} at ${hhmm(firstAlert.receivedAt)} UTC. ` +
      "Replace this with the confirmed root cause and the contributing factors."
    : "Describe the confirmed root cause and the contributing factors.";

  const resolvedEvent = [...timeline].reverse().find((e) => e.type === "INCIDENT_RESOLVED");
  const resolution = resolvedEvent
    ? `${resolvedEvent.message}${resolvedEvent.actorName ? ` (${resolvedEvent.actorName})` : ""}`
    : "Describe how the incident was mitigated and resolved.";

  // Starting points for the retrospective, from facts the platform can see.
  const well: string[] = [];
  const poorly: string[] = [];
  if (alerts.length > 0) well.push(`Monitoring detected it: ${firstAlert!.source} alerted at ${hhmm(firstAlert!.receivedAt)} UTC.`);
  if (metrics.timeToAcknowledgeSeconds !== null && metrics.timeToAcknowledgeSeconds <= 5 * 60 && metrics.ackTimeouts === 0) {
    well.push(`Acknowledged within ${formatDuration(metrics.timeToAcknowledgeSeconds)}.`);
  }
  if (incident.mitigatedAt && incident.resolvedAt && incident.mitigatedAt < incident.resolvedAt) {
    well.push(`Customer impact was stopped (mitigated) after ${formatDuration(metrics.timeToMitigateSeconds)}, before the full fix.`);
  }
  if (metrics.notesCount > 0) well.push(`Responders kept a running log (${metrics.notesCount} notes on the timeline).`);
  if (alerts.length === 0) poorly.push("No automated alert fired — the incident was declared by hand.");
  if (metrics.ackTimeouts > 0) poorly.push("Nobody acknowledged within the acknowledgement timeout.");
  if (metrics.escalations > 0) poorly.push(`The page escalated ${metrics.escalations} time(s) before someone took ownership.`);
  if (metrics.timeToAcknowledgeSeconds !== null && metrics.timeToAcknowledgeSeconds > 15 * 60) {
    poorly.push(`Time to acknowledge was ${formatDuration(metrics.timeToAcknowledgeSeconds)}.`);
  }
  if (alerts.length > 5) poorly.push(`${alerts.length} alerts fired for one problem (noise).`);

  const item = (description: string): ActionItem => ({ id: newActionItemId(), description, owner: "", dueDate: null, done: false });
  const actionItems: ActionItem[] = [item("Confirm the root cause and document it in this postmortem")];
  if (metrics.escalations > 0 || metrics.ackTimeouts > 0) {
    actionItems.push(
      item(`Review on-call coverage: the incident escalated ${metrics.escalations} time(s) before anyone acknowledged it`)
    );
  }
  if (metrics.timeToAcknowledgeSeconds !== null && metrics.timeToAcknowledgeSeconds > 15 * 60) {
    actionItems.push(item(`Time to acknowledge was ${formatDuration(metrics.timeToAcknowledgeSeconds)} — check paging/notification settings`));
  }
  if (alerts.length > 5) {
    actionItems.push(item(`${alerts.length} alerts fired for one problem — tune alert rules or dedup keys to reduce noise`));
  }
  if (alerts.length === 0) {
    actionItems.push(item("No automated alert fired — add monitoring that would have detected this"));
  }

  return {
    summary,
    impact,
    rootCause,
    resolution,
    whatWentWell: well.map((l) => `- ${l}`).join("\n"),
    whatWentPoorly: poorly.map((l) => `- ${l}`).join("\n"),
    actionItems,
    metrics,
    timeline: curateTimeline(timeline),
  };
}

// The whole postmortem as a Markdown document (export / paste into a wiki).
export function renderPostmortemMarkdown(pm: {
  number: number;
  title: string;
  severity: IncidentSeverity;
  serviceName: string | null;
  status: string;
  triggeredAt: Date;
  resolvedAt: Date | null;
  summary: string;
  impact: string;
  rootCause: string;
  resolution: string;
  whatWentWell: string;
  whatWentPoorly: string;
  actionItems: ActionItem[];
  metrics: Partial<PostmortemMetrics>;
  timeline: PostmortemTimelineEntry[];
}) {
  const section = (title: string, body: string) => `## ${title}\n\n${body.trim() || "_Not written yet._"}\n`;
  const m = pm.metrics;
  const timeline = pm.timeline
    .filter((e) => !e.hidden)
    .map((e) => `- **${hhmm(new Date(e.at))}** ${e.message}${e.actor ? ` _(${e.actor})_` : ""}`)
    .join("\n");
  const items = pm.actionItems
    .map((a) => `- [${a.done ? "x" : " "}] ${a.description}${a.owner ? ` — ${a.owner}` : ""}${a.dueDate ? ` (due ${a.dueDate})` : ""}`)
    .join("\n");
  return [
    `# ${incidentRef(pm.number)} Postmortem${pm.status === "draft" ? " (draft)" : ""}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| **Incident** | ${pm.title} |`,
    `| **Service** | ${pm.serviceName ?? "—"} |`,
    `| **Severity** | ${sevLabel(pm.severity)} |`,
    `| **Duration** | ${formatDurationLong(m.durationSeconds ?? m.timeToResolveSeconds ?? null)} (${hhmm(pm.triggeredAt)}–${pm.resolvedAt ? hhmm(pm.resolvedAt) : "…"} UTC, ${pm.triggeredAt.toISOString().slice(0, 10)}) |`,
    `| **Time to acknowledge / mitigate / resolve** | ${formatDuration(m.timeToAcknowledgeSeconds ?? null)} / ${formatDuration(m.timeToMitigateSeconds ?? null)} / ${formatDuration(m.timeToResolveSeconds ?? null)} |`,
    "",
    section("Summary", pm.summary),
    section("Impact", pm.impact),
    section("Timeline (UTC)", timeline),
    section("Root cause", pm.rootCause),
    section("Resolution", pm.resolution),
    section("What went well", pm.whatWentWell),
    section("What went poorly", pm.whatWentPoorly),
    section("Action items", items),
    "_Timeline generated from the incident's append-only, hash-chained event log._",
    "",
  ].join("\n");
}
