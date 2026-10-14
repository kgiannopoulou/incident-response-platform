import { describe, expect, it } from "vitest";
import {
  buildPostmortemDraft,
  curateTimeline,
  formatDuration,
  formatDurationLong,
  mergeTimelineVisibility,
  renderPostmortemMarkdown,
  sevLabel,
} from "../src/postmortem";

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 14, 0) + min * 60_000);

const input = {
  incident: {
    number: 42,
    title: "Checkout API returning 500s",
    severity: "sev1" as const,
    serviceName: "Checkout API",
    triggeredAt: t(0),
    acknowledgedAt: t(20),
    mitigatedAt: t(45),
    resolvedAt: t(65),
  },
  alerts: [
    { title: "5xx rate above 5%", severity: "critical", source: "prometheus", receivedAt: t(0) },
    { title: "p99 latency high", severity: "high", source: "datadog", receivedAt: t(2) },
  ],
  timeline: [
    { id: 1, hash: "h1", type: "INCIDENT_CREATED", message: "Incident opened by alert", actorName: null, createdAt: t(0) },
    { id: 2, hash: "h2", type: "ALERT_ATTACHED", message: 'Alert grouped: "p99 latency high" from datadog', actorName: null, createdAt: t(2) },
    { id: 3, hash: "h3", type: "ALERT_ATTACHED", message: 'Alert grouped: "5xx rate above 5%" from prometheus', actorName: null, createdAt: t(3) },
    { id: 4, hash: "h4", type: "ACK_TIMEOUT", message: "Not acknowledged within 5 min", actorName: null, createdAt: t(5) },
    { id: 5, hash: "h5", type: "INCIDENT_ESCALATED", message: "Escalated to level 2", actorName: null, createdAt: t(5) },
    { id: 6, hash: "h6", type: "RESPONDER_ADDED", message: "Jordan joined", actorName: "Jordan", createdAt: t(19) },
    { id: 7, hash: "h7", type: "INCIDENT_ACKNOWLEDGED", message: "Acknowledged", actorName: "Alex", createdAt: t(20) },
    { id: 8, hash: "h8", type: "NOTE_ADDED", message: "Database connections appear exhausted", actorName: "Alex", createdAt: t(27) },
    { id: 9, hash: "h9", type: "NOTE_ADDED", message: "Rolled back deploy 1.4.2", actorName: "Alex", createdAt: t(40) },
    { id: 10, hash: "h10", type: "INCIDENT_RESOLVED", message: "Resolved: rollback restored error rate", actorName: "Alex", createdAt: t(65) },
    { id: 11, hash: "h11", type: "POSTMORTEM_GENERATED", message: "Postmortem draft generated", actorName: null, createdAt: t(65) },
  ],
  responders: [{ name: "Alex", role: "commander" }],
};
const draft = buildPostmortemDraft(input);

describe("buildPostmortemDraft", () => {
  it("computes response metrics", () => {
    expect(draft.metrics).toEqual({
      durationSeconds: 3900,
      timeToAcknowledgeSeconds: 1200,
      timeToMitigateSeconds: 2700,
      timeToResolveSeconds: 3900,
      alertCount: 2,
      escalations: 1,
      ackTimeouts: 1,
      notesCount: 2,
      responderCount: 1,
    });
  });

  it("writes narrative sections from the incident data", () => {
    expect(draft.summary).toContain("INC-42");
    expect(draft.summary).toContain("resolved after 1h 5m");
    expect(draft.impact).toContain("prometheus, datadog");
    expect(draft.impact).toContain("impacted for 45m 0s (mitigated, then fully resolved after 1h 5m)");
    expect(draft.rootCause).toContain("5xx rate above 5%");
    expect(draft.resolution).toBe("Resolved: rollback restored error rate (Alex)");
  });

  it("starts 'what went well / poorly' from facts the platform saw", () => {
    expect(draft.whatWentWell).toContain("- Monitoring detected it: prometheus alerted at 14:00 UTC.");
    expect(draft.whatWentWell).toContain("mitigated) after 45m 0s, before the full fix");
    expect(draft.whatWentWell).toContain("2 notes on the timeline");
    expect(draft.whatWentPoorly).toContain("- Nobody acknowledged within the acknowledgement timeout.");
    expect(draft.whatWentPoorly).toContain("Time to acknowledge was 20m 0s.");
  });

  it("suggests action items with stable ids", () => {
    const items = draft.actionItems.map((a) => a.description).join("\n");
    expect(items).toMatch(/escalated 1 time/);
    expect(items).toMatch(/Time to acknowledge was 20m 0s/);
    for (const item of draft.actionItems) {
      expect(item).toMatchObject({ id: expect.stringMatching(/^ai_[a-z0-9]+$/), owner: "", dueDate: null, done: false });
    }
    expect(new Set(draft.actionItems.map((a) => a.id)).size).toBe(draft.actionItems.length);
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(3900)).toBe("1h 5m");
    expect(formatDurationLong(37 * 60)).toBe("37 minutes");
    expect(formatDurationLong(3900)).toBe("1 hour 5 minutes");
    expect(formatDurationLong(7200)).toBe("2 hours");
    expect(formatDurationLong(1)).toBe("1 second");
    expect(sevLabel("sev1")).toBe("SEV-1");
  });
});

describe("curateTimeline", () => {
  const timeline = curateTimeline(input.timeline);

  it("keeps the story, collapses alert runs and drops housekeeping", () => {
    expect(timeline.map((e) => e.type)).toEqual([
      "INCIDENT_CREATED",
      "ALERT_ATTACHED",
      "ACK_TIMEOUT",
      "INCIDENT_ESCALATED",
      "INCIDENT_ACKNOWLEDGED",
      "NOTE_ADDED",
      "NOTE_ADDED",
      "INCIDENT_RESOLVED",
    ]);
    expect(timeline[1].message).toBe('2 more alerts grouped into the incident (first: "p99 latency high" from datadog)');
  });

  it("links every entry to its audit-log event and hash", () => {
    expect(timeline[0]).toEqual({
      eventId: 1,
      hash: "h1",
      at: t(0).toISOString(),
      type: "INCIDENT_CREATED",
      message: "Incident opened by alert",
      actor: null,
      hidden: false,
    });
    expect(timeline[5]).toMatchObject({ eventId: 8, actor: "Alex", message: "Database connections appear exhausted" });
  });

  it("remembers hidden entries across a rebuild", () => {
    const previous = timeline.map((e) => (e.eventId === 4 ? { ...e, hidden: true } : e));
    const rebuilt = mergeTimelineVisibility(curateTimeline(input.timeline), previous);
    expect(rebuilt.filter((e) => e.hidden).map((e) => e.eventId)).toEqual([4]);
  });
});

describe("renderPostmortemMarkdown", () => {
  const markdown = renderPostmortemMarkdown({
    number: 42,
    title: input.incident.title,
    severity: "sev1",
    serviceName: "Checkout API",
    status: "published",
    triggeredAt: t(0),
    resolvedAt: t(65),
    summary: draft.summary,
    impact: "Customers were unable to complete checkout.",
    rootCause: "Connection pool exhausted after the 1.4.2 deploy doubled queries per request.",
    resolution: draft.resolution,
    whatWentWell: draft.whatWentWell,
    whatWentPoorly: "",
    actionItems: [
      { id: "ai_1", description: "Add DB connection alerts", owner: "Sam", dueDate: "2026-10-21", done: false },
      { id: "ai_2", description: "Review connection pool limits", owner: "", dueDate: null, done: true },
    ],
    metrics: draft.metrics,
    timeline: draft.timeline.map((e) => (e.type === "ACK_TIMEOUT" ? { ...e, hidden: true } : e)),
  });

  it("renders the document in the familiar postmortem layout", () => {
    expect(markdown).toMatch(/^# INC-42 Postmortem\n/);
    expect(markdown).toContain("| **Severity** | SEV-1 |");
    expect(markdown).toContain("| **Duration** | 1 hour 5 minutes (14:00–15:05 UTC, 2026-10-01) |");
    expect(markdown).toContain("## Impact\n\nCustomers were unable to complete checkout.");
    expect(markdown).toContain("- **14:27** Database connections appear exhausted _(Alex)_");
    expect(markdown).toContain("- [ ] Add DB connection alerts — Sam (due 2026-10-21)");
    expect(markdown).toContain("- [x] Review connection pool limits");
    expect(markdown).toContain("## What went poorly\n\n_Not written yet._");
  });

  it("leaves hidden timeline entries out", () => {
    expect(markdown).not.toContain("Not acknowledged within 5 min");
  });
});
