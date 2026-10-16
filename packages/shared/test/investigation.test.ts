import { describe, expect, it } from "vitest";
import {
  analyzeEvidence,
  deploymentPayloadSchema,
  demoLogEntries,
  investigationFindingsSchema,
  logBatchSchema,
  logFingerprint,
  PRODUCTION_INCIDENT,
  validateFindings,
  type EvidenceBundle,
} from "../src/index";

const T = Date.parse("2026-10-16T14:00:00Z");
const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString();

// The demo story, as the evidence store would return it: checkout-api v2.14.0
// deployed 6 minutes before the first alert, new pool-timeout errors after it,
// Postgres running out of connections, and an unrelated auth-service deploy.
function demoBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    incident: {
      number: 65,
      title: "Checkout error rate exceeded threshold",
      severity: "sev1",
      status: "investigating",
      service: "checkout-api",
      serviceName: "Checkout API",
      triggeredAt: at(0),
      acknowledgedAt: at(2),
      resolvedAt: null,
      firstAlertAt: at(0),
    },
    window: { from: at(-120), to: at(20) },
    dependencies: { upstream: ["auth-service", "postgres-primary"], downstream: [] },
    alerts: [
      { id: "alert:a1", service: "checkout-api", at: at(0), lastAt: at(10), severity: "critical", title: "Checkout error rate exceeded threshold", count: 3, incident: 65 },
      { id: "alert:a2", service: "postgres-primary", at: at(1), lastAt: at(1), severity: "critical", title: "Connection pool exhausted (500/500)", count: 1, incident: 66 },
    ],
    deployments: [
      { id: "deploy:2", service: "auth-service", version: "v5.2.1", kind: "deploy", status: "succeeded", description: "Rotate session signing keys", author: "Riley", commitSha: null, startedAt: at(-50), finishedAt: null, previousVersion: "v5.2.0" },
      { id: "deploy:3", service: "checkout-api", version: "v2.14.0", kind: "deploy", status: "succeeded", description: "Raise checkout worker concurrency 8 → 32 per pod", author: "Jordan", commitSha: "e41f9b2", startedAt: at(-6), finishedAt: at(-5), previousVersion: "v2.13.4" },
    ],
    logGroups: [
      { id: "log:10", service: "checkout-api", level: "warn", sample: "slow query: SELECT * FROM carts WHERE id = 1 took 812ms", count: 6, firstAt: at(-40), lastAt: at(-39), baselineCount: 5, isNew: false },
      { id: "log:20", service: "checkout-api", level: "error", sample: "timeout acquiring connection from pool after 5000ms (order 81231)", count: 190, firstAt: at(-2), lastAt: at(10), baselineCount: 0, isNew: true },
      { id: "log:30", service: "postgres-primary", level: "fatal", sample: "remaining connection slots are reserved for non-replication superuser connections", count: 25, firstAt: at(1), lastAt: at(2), baselineCount: 0, isNew: true },
    ],
    relatedIncidents: [{ id: "incident:INC-66", number: 66, service: "postgres-primary", title: "Connection pool exhausted (500/500)", severity: "sev1", status: "triggered", triggeredAt: at(1) }],
    timeline: [
      { id: "event:1", at: at(0), type: "INCIDENT_CREATED", message: "Incident opened by alert", actor: null },
      { id: "event:2", at: at(2), type: "INCIDENT_ACKNOWLEDGED", message: "Acknowledged", actor: "Sam Rivera" },
    ],
    ...overrides,
  };
}

describe("analyzeEvidence (offline investigator)", () => {
  it("ranks the deploy before the failure first, with its evidence, and the database as a likely symptom", () => {
    const f = analyzeEvidence(demoBundle());
    const [top, second] = f.hypotheses;
    expect(top).toMatchObject({ id: "h1", category: "deployment", confidence: "high" });
    expect(top.title).toBe("Deploy v2.14.0 of Checkout API triggered the failure");
    expect(top.supportingEvidence).toEqual(expect.arrayContaining(["deploy:3", "log:20", "alert:a2", "alert:a1"]));
    expect(top.reasoning).toMatch(/6 min before the first alert/);
    expect(top.reasoning).toMatch(/database connection exhaustion/);
    expect(top.nextChecks[0]).toMatch(/Diff v2\.14\.0 against v2\.13\.4 \(commit e41f9b2\)/);

    const db = f.hypotheses.find((h) => h.category === "dependency")!;
    expect(db.title).toMatch(/postgres-primary failing \(database connection exhaustion\)/);
    expect(db.reasoning).toMatch(/symptom rather than the cause/);
    expect(db.supportingEvidence).toEqual(expect.arrayContaining(["incident:INC-66", "log:30"]));
    expect(second.score!).toBeLessThan(top.score!);

    // The unrelated auth deploy (50 min earlier, no new errors) ranks below both.
    const auth = f.hypotheses.find((h) => h.supportingEvidence.includes("deploy:2"))!;
    expect(f.hypotheses.indexOf(auth)).toBeGreaterThan(1);
    expect(auth.confidence).toBe("low");
    expect(auth.reasoning).toMatch(/No new errors appeared on auth-service/);
    expect(f.summary).toMatch(/^Most likely: Deploy v2\.14\.0 of Checkout API triggered the failure \(high confidence\)/);
  });

  it("reconstructs the timeline oldest first, from changes to responders", () => {
    const f = analyzeEvidence(demoBundle());
    const kinds = f.timeline.map((e) => e.kind);
    expect(f.timeline.map((e) => e.at)).toEqual([...f.timeline.map((e) => e.at)].sort());
    expect(kinds[0]).toBe("deployment"); // auth deploy at -50
    expect(f.timeline.find((e) => e.evidenceIds.includes("deploy:3"))!.title).toMatch(/Checkout API: deploy v2\.14\.0/);
    expect(f.timeline.some((e) => e.kind === "action" && /Sam Rivera/.test(e.title))).toBe(true);
    expect(f.timeline.every((e) => e.evidenceIds.length > 0)).toBe(true);
  });

  it("puts the dependency first when it failed well before the service and nothing changed", () => {
    const f = analyzeEvidence(
      demoBundle({
        deployments: [],
        alerts: [
          { id: "alert:a1", service: "checkout-api", at: at(0), lastAt: at(5), severity: "critical", title: "Checkout error rate exceeded threshold", count: 2, incident: 65 },
          { id: "alert:p1", service: "postgres-primary", at: at(-8), lastAt: at(-8), severity: "critical", title: "Replication lag 900s", count: 1, incident: null },
        ],
        logGroups: [],
        relatedIncidents: [],
      })
    );
    expect(f.hypotheses[0]).toMatchObject({ category: "dependency", confidence: "medium" });
    expect(f.hypotheses[0].reasoning).toMatch(/8 min before/);
    expect(f.openQuestions.join(" ")).toMatch(/No deployments were reported for checkout-api, auth-service, postgres-primary/);
  });

  it("flags a deploy that came after the errors started as contradicted", () => {
    const f = analyzeEvidence(
      demoBundle({
        deployments: [{ ...demoBundle().deployments[1], startedAt: at(3) }],
        logGroups: [{ id: "log:5", service: "checkout-api", level: "error", sample: "payment gateway returned 502", count: 40, firstAt: at(-20), lastAt: at(5), baselineCount: 0, isNew: true }],
      })
    );
    const deploy = f.hypotheses.find((h) => h.category === "deployment")!;
    expect(deploy.confidence).toBe("low");
    expect(deploy.contradictingEvidence).toEqual(expect.arrayContaining(["log:5", "alert:a1"]));
    expect(deploy.reasoning).toMatch(/after\* the first alert/);
  });

  it("says so when there is no evidence, instead of guessing", () => {
    const f = analyzeEvidence(demoBundle({ alerts: [], deployments: [], logGroups: [], relatedIncidents: [], dependencies: { upstream: [], downstream: [] } }));
    expect(f.hypotheses).toHaveLength(1);
    expect(f.hypotheses[0]).toMatchObject({ category: "unknown", confidence: "low" });
    expect(f.summary).toMatch(/No likely cause found/);
    expect(f.openQuestions.join(" ")).toMatch(/No dependencies are recorded/);
  });
});

describe("validateFindings", () => {
  const findings = {
    summary: "Deploy v2.14.0 exhausted DB connections.",
    hypotheses: [
      { title: "Deploy", statement: "s", category: "deployment" as const, confidence: "high" as const, supportingEvidence: ["deploy:3", "deploy:999", "deploy:3"], contradictingEvidence: [], reasoning: "r", nextChecks: ["roll back"] },
      { title: "Invented", statement: "s", category: "external" as const, confidence: "high" as const, supportingEvidence: ["alert:made-up"], contradictingEvidence: [], reasoning: "r", nextChecks: [] },
    ],
    timeline: [
      { at: "2026-10-16T14:05:00Z", kind: "alert" as const, title: "later", evidenceIds: ["alert:a1"] },
      { at: "not a date", kind: "log" as const, title: "bad", evidenceIds: [] },
      { at: "2026-10-16T13:54:00Z", kind: "deployment" as const, title: "earlier", evidenceIds: ["deploy:3"] },
    ],
    openQuestions: [],
  };

  it("removes citations of evidence that was never retrieved and downgrades unsupported hypotheses", () => {
    expect(investigationFindingsSchema.safeParse(findings).success).toBe(true);
    const { findings: out, warnings } = validateFindings(findings, new Set(["deploy:3", "alert:a1"]));
    expect(out.hypotheses[0]).toMatchObject({ id: "h1", supportingEvidence: ["deploy:3"], confidence: "high" });
    expect(out.hypotheses[1]).toMatchObject({ id: "h2", supportingEvidence: [], confidence: "low" });
    expect(out.timeline.map((e) => e.title)).toEqual(["earlier", "later"]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/never retrieved \(hypothesis 1\): deploy:999/),
        expect.stringMatching(/Hypothesis 2 \("Invented"\) cites no retrieved evidence/),
        expect.stringMatching(/without a valid timestamp/),
      ])
    );
  });
});

describe("telemetry payloads", () => {
  it("fingerprints log lines with their variable parts masked", () => {
    expect(logFingerprint("timeout acquiring connection from pool after 5000ms (order 81231)")).toBe(
      logFingerprint("Timeout acquiring connection from pool after 4990ms (order 99)")
    );
    expect(logFingerprint('user "alice" from 10.1.2.3:5432 id 9f8e7d6c5b4a')).toBe("user <str> from <ip> id <hex>");
    expect(logFingerprint("a")).not.toBe(logFingerprint("b"));
  });

  it("validates deployments and log batches", () => {
    expect(deploymentPayloadSchema.parse({ version: "v2.14.0", commitSha: "E41F9B2" })).toMatchObject({ commitSha: "e41f9b2", status: "succeeded", kind: "deploy", environment: "production" });
    expect(deploymentPayloadSchema.safeParse({ version: "v1", commitSha: "not-hex" }).success).toBe(false);
    expect(logBatchSchema.parse({ entries: [{ level: "WARNING", message: "x" }, { level: "critical", message: "y" }] }).entries.map((e) => e.level)).toEqual(["warn", "fatal"]);
    expect(logBatchSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(logBatchSchema.safeParse({ entries: Array(501).fill({ level: "info", message: "x" }) }).success).toBe(false);
  });

  it("the demo scenario's changes and logs are valid payloads that tell the story", () => {
    for (const c of PRODUCTION_INCIDENT.changes ?? []) expect(deploymentPayloadSchema.safeParse(c.deployment).success).toBe(true);
    const logs = PRODUCTION_INCIDENT.steps.flatMap((s) => s.logs ?? []);
    for (const l of logs) expect(logBatchSchema.safeParse({ entries: demoLogEntries(l, new Date(), "run") }).success).toBe(true);
    const entries = demoLogEntries(logs.find((l) => l.message.includes("acquiring"))!, new Date(T), "run");
    expect(new Set(entries.map((e) => e.message)).size).toBeGreaterThan(1); // the numbers vary
    expect(new Set(entries.map((e) => logFingerprint(e.message))).size).toBe(1); // one pattern
    expect(PRODUCTION_INCIDENT.changes!.at(-1)).toMatchObject({ service: "checkout-api", minutesBefore: 6, deployment: { version: "v2.14.0" } });
  });
});
