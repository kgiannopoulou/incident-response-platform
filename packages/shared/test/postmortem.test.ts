import { describe, expect, it } from "vitest";
import { buildPostmortemDraft, formatDuration } from "../src/postmortem";

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 14, 0) + min * 60_000);

describe("buildPostmortemDraft", () => {
  const draft = buildPostmortemDraft({
    incident: {
      number: 42,
      title: "Checkout API returning 500s",
      severity: "sev1",
      serviceName: "Checkout API",
      triggeredAt: t(0),
      acknowledgedAt: t(20),
      resolvedAt: t(65),
    },
    alerts: [
      { title: "5xx rate above 5%", severity: "critical", source: "prometheus", receivedAt: t(0) },
      { title: "p99 latency high", severity: "high", source: "datadog", receivedAt: t(2) },
    ],
    timeline: [
      { type: "incident_created", message: "Incident opened by alert", actorName: null, createdAt: t(0) },
      { type: "escalated", message: "Escalated to level 2", actorName: null, createdAt: t(10) },
      { type: "acknowledged", message: "Acknowledged", actorName: "Alex", createdAt: t(20) },
      { type: "note", message: "Rolled back deploy 1.4.2", actorName: "Alex", createdAt: t(40) },
      { type: "resolved", message: "Resolved: rollback restored error rate", actorName: "Alex", createdAt: t(65) },
    ],
    responders: [{ name: "Alex", role: "commander" }],
  });

  it("computes response metrics", () => {
    expect(draft.metrics).toEqual({
      timeToAcknowledgeSeconds: 1200,
      timeToResolveSeconds: 3900,
      alertCount: 2,
      escalations: 1,
      notesCount: 1,
      responderCount: 1,
    });
  });

  it("writes narrative sections from the incident data", () => {
    expect(draft.summary).toContain("INC-42");
    expect(draft.summary).toContain("resolved after 1h 5m");
    expect(draft.impact).toContain("prometheus, datadog");
    expect(draft.rootCause).toContain("5xx rate above 5%");
    expect(draft.resolution).toBe("Resolved: rollback restored error rate (Alex)");
  });

  it("suggests action items from what happened", () => {
    const items = draft.actionItems.map((a) => a.description).join("\n");
    expect(items).toMatch(/escalated 1 time/);
    expect(items).toMatch(/Time to acknowledge was 20m 0s/);
  });

  it("renders the timeline in order", () => {
    expect(draft.timelineMarkdown.split("\n")[0]).toBe("- **14:00 UTC** — Incident opened by alert");
    expect(draft.timelineMarkdown).toContain("_(Alex)_");
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(3900)).toBe("1h 5m");
  });
});
