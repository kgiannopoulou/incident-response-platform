import type Anthropic from "@anthropic-ai/sdk";
import { Queue, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { logFingerprint, QUEUES, type InvestigationFindings } from "@irp/shared";
import type { Pool } from "pg";
import type { WorkerContext } from "../src/context";
import { rulesDrafter } from "../src/ai-drafter";
import { EvidenceStore } from "../src/investigator/evidence";
import { AGENT_LIMITS, createClaudeInvestigator, INVESTIGATOR_TOOLS, rulesInvestigator, type Investigator } from "../src/investigator/investigators";
import { runInvestigation } from "../src/investigator/run";
import { sweep } from "../src/sweeper";

// The AI Incident Investigator against a real Postgres: the evidence store's
// tenant scoping and grouping, the offline investigator end to end, and the
// Claude agent's loop driven by a scripted fake client (the exact requests it
// sends, the tool results it gets back, citation checking, failure modes).

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
let postgresId: number;
let incidentId: number;
const ids: Record<string, number> = {};

beforeAll(async () => {
  pool = await setupTestDatabase();
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6380");
  url.pathname = "/2";
  const connection = { url: url.toString() };
  ctx = {
    pool,
    redis: new Redis(url.toString(), { maxRetriesPerRequest: null }),
    notificationsQueue: new Queue(QUEUES.notifications, { connection }),
    escalationsQueue: new Queue(QUEUES.escalations, { connection }),
    webhooksQueue: new Queue(QUEUES.webhooks, { connection }),
    deadLetterQueue: new Queue(QUEUES.deadLetter, { connection }),
    aiDraftsQueue: new Queue(QUEUES.aiDrafts, { connection }),
    investigationsQueue: new Queue(QUEUES.investigations, { connection }),
    drafter: rulesDrafter,
    investigator: rulesInvestigator,
    email: async () => ({ messageId: null }),
    webOrigin: "http://fireline.test",
    blockPrivateWebhookTargets: false,
  };
});
afterAll(async () => {
  await Promise.all([ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue, ctx.aiDraftsQueue, ctx.investigationsQueue].map((q) => q.close()));
  await ctx.redis.quit();
  await pool.end();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

async function alert(serviceId: number, orgId: number, title: string, severity: string, at: Date, publicId: string) {
  return (
    await q(
      `INSERT INTO alerts (organization_id, service_id, public_id, dedup_key, title, severity, source, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'prometheus', $7) RETURNING id`,
      [orgId, serviceId, publicId, `k-${publicId}`, title, severity, at]
    )
  ).id as number;
}
async function logs(serviceId: number, orgId: number, level: string, message: string, count: number, from: Date) {
  for (let i = 0; i < count; i++) {
    const m = message.replace("{n}", String(1000 + i * 37));
    await pool.query(`INSERT INTO log_events (organization_id, service_id, ts, level, message, fingerprint) VALUES ($1, $2, $3, $4, $5, $6)`, [
      orgId,
      serviceId,
      new Date(from.getTime() + i * 1000),
      level,
      m,
      logFingerprint(m),
    ]);
  }
}

// The demo story: checkout-api v2.14.0 deployed 6 minutes before the first
// alert; new pool-timeout errors; Postgres out of connections (its own SEV1);
// plus a tempting deployment in *another* organization that must stay invisible.
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  const acme = fx.orgs.acme;
  postgresId = (await q(`INSERT INTO services (organization_id, name, slug) VALUES ($1, 'PostgreSQL Primary', 'postgres-primary') RETURNING id`, [acme])).id;
  await pool.query(`INSERT INTO service_dependencies (service_id, depends_on_service_id) VALUES ($1, $2), ($1, $3)`, [fx.services.checkout, postgresId, fx.services.auth]);

  ids.oldDeploy = (await q(`INSERT INTO deployments (organization_id, service_id, version, description, started_at) VALUES ($1, $2, 'v2.13.4', 'Retry card authorisation', $3) RETURNING id`, [acme, fx.services.checkout, minutesAgo(26 * 60)])).id;
  ids.deploy = (
    await q(
      `INSERT INTO deployments (organization_id, service_id, version, commit_sha, author, description, started_at)
       VALUES ($1, $2, 'v2.14.0', 'e41f9b2', 'Jordan', 'Raise checkout worker concurrency 8 → 32 per pod', $3) RETURNING id`,
      [acme, fx.services.checkout, minutesAgo(16)]
    )
  ).id;
  ids.foreignDeploy = (
    await q(`INSERT INTO deployments (organization_id, service_id, version, description, started_at) VALUES ($1, $2, 'v9.9.9', 'Other tenant secret project', $3) RETURNING id`, [
      fx.orgs.other,
      fx.services.other,
      minutesAgo(12),
    ])
  ).id;

  await logs(fx.services.checkout, acme, "error", "timeout acquiring connection from pool after 5000ms (order {n})", 30, minutesAgo(11));
  await logs(postgresId, acme, "fatal", "remaining connection slots are reserved for non-replication superuser connections", 5, minutesAgo(9));
  await logs(fx.services.checkout, acme, "error", "login failed for alice@example.com password=hunter2 token=abc123", 2, minutesAgo(9));

  incidentId = (
    await q(
      `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, triggered_at)
       VALUES ($1, 65, $2, 'Checkout error rate exceeded threshold', 'sev1', 'investigating', $3) RETURNING id`,
      [acme, fx.services.checkout, minutesAgo(10)]
    )
  ).id;
  const a1 = await alert(fx.services.checkout, acme, "Checkout error rate exceeded threshold", "critical", minutesAgo(10), "alert_A1");
  await pool.query(`INSERT INTO incident_alerts (incident_id, alert_id) VALUES ($1, $2)`, [incidentId, a1]);
  await q(`INSERT INTO incidents (organization_id, number, service_id, title, severity, triggered_at) VALUES ($1, 66, $2, 'Connection pool exhausted (500/500)', 'sev1', $3) RETURNING id`, [
    acme,
    postgresId,
    minutesAgo(9),
  ]);
  await alert(postgresId, acme, "Connection pool exhausted (500/500)", "critical", minutesAgo(9), "alert_P1");
  await alert(fx.services.other, fx.orgs.other, "Other tenant alert", "critical", minutesAgo(9), "alert_X1");
});

const queued = async (investigator: Investigator = rulesInvestigator) => {
  ctx.investigator = investigator;
  return (await q(`INSERT INTO incident_investigations (organization_id, incident_id) VALUES ($1, $2) RETURNING id`, [fx.orgs.acme, incidentId])).id as number;
};
const row = async (id: number) => q(`SELECT * FROM incident_investigations WHERE id = $1`, [id]);

describe("evidence store", () => {
  it("sees only the incident's organization, groups logs into patterns and redacts them", async () => {
    const store = (await EvidenceStore.open(pool, incidentId))!;
    expect(await store.dependencies()).toEqual({ upstream: ["auth-service", "postgres-primary"], downstream: [] });
    expect((await store.deployments()).map((d) => d.version)).toEqual(["v2.14.0"]);
    expect((await store.deployments({ from: minutesAgo(27 * 60).toISOString() }))[0]).toMatchObject({ version: "v2.13.4" });
    expect((await store.deployments({ service: "other-api" }))).toEqual([]); // another tenant's service: nothing
    expect((await store.alerts()).map((a) => a.id).sort()).toEqual(["alert:alert_A1", "alert:alert_P1"]);

    const groups = await store.logs();
    const pool30 = groups.find((g) => g.sample.startsWith("timeout acquiring"))!;
    expect(pool30).toMatchObject({ service: "checkout-api", level: "error", count: 30, isNew: true, baselineCount: 0 });
    const leaked = groups.find((g) => g.sample.startsWith("login failed"))!;
    expect(leaked.sample).toBe("login failed for [email] password=[redacted] token=[redacted]");
    expect((await store.logs({ query: "100%_" }))).toEqual([]); // LIKE wildcards are escaped

    expect([...store.ledger.keys()].some((id) => id.includes(String(ids.foreignDeploy)) && id.startsWith("deploy:"))).toBe(false);
    expect(store.ledger.has(`deploy:${ids.deploy}`)).toBe(true);
  });
});

describe("runInvestigation with the offline investigator", () => {
  it("stores ranked findings whose citations all resolve to evidence in the ledger", async () => {
    const id = await queued();
    expect(await runInvestigation(ctx, id)).toMatchObject({ skipped: false });
    const r = await row(id);
    expect(r).toMatchObject({ status: "completed", provider: "rules", model: null, error: null, attempts: 1 });
    const findings = r.findings as InvestigationFindings;
    expect(findings.hypotheses[0]).toMatchObject({ category: "deployment", confidence: "high", title: "Deploy v2.14.0 of Checkout API triggered the failure" });
    expect(findings.hypotheses[0].supportingEvidence).toContain(`deploy:${ids.deploy}`);
    const cited = [...findings.hypotheses.flatMap((h) => [...h.supportingEvidence, ...h.contradictingEvidence]), ...findings.timeline.flatMap((e) => e.evidenceIds)];
    expect(cited.length).toBeGreaterThan(5);
    expect(cited.every((c) => c in r.evidence)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Other tenant|v9\.9\.9|hunter2/);
    expect(r.steps).toEqual([expect.objectContaining({ tool: "collect_evidence" })]);
  });

  it("is idempotent and never touches the incident", async () => {
    const id = await queued();
    const before = await q(`SELECT status, severity, (SELECT count(*)::int FROM timeline_events) AS events FROM incidents WHERE id = $1`, [incidentId]);
    await runInvestigation(ctx, id);
    expect(await runInvestigation(ctx, id)).toEqual({ skipped: true });
    expect(await q(`SELECT status, severity, (SELECT count(*)::int FROM timeline_events) AS events FROM incidents WHERE id = $1`, [incidentId])).toEqual(before);
  });

  it("the sweeper re-enqueues a queued investigation whose job was lost", async () => {
    const id = await queued();
    await pool.query(`UPDATE incident_investigations SET created_at = now() - interval '2 minutes' WHERE id = $1`, [id]);
    await sweep(ctx);
    expect(await ctx.investigationsQueue.getJob(`investigation-${id}`)).toBeDefined();
  });
});

// --- The Claude agent, with a scripted model --------------------------------

type Turn = { content: unknown[]; stop_reason?: string };
function fakeClient(turns: Turn[]) {
  // Snapshots: the agent keeps appending to the same messages array.
  const requests: Record<string, any>[] = [];
  const create = vi.fn(async (params: unknown) => {
    requests.push(structuredClone(params) as Record<string, any>);
    const turn = turns.shift();
    if (!turn) throw new Error("no more scripted turns");
    return { id: "msg", model: "claude-opus-5-5", content: turn.content, stop_reason: turn.stop_reason ?? "tool_use", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 } };
  });
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create, requests };
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const submit = (supporting: string[]) =>
  toolUse("t9", "submit_findings", {
    summary: "v2.14.0 multiplied checkout's DB connections until Postgres ran out.",
    hypotheses: [
      {
        title: "Deploy v2.14.0 exhausted Postgres connections",
        statement: "Raising worker concurrency 4× raised checkout's connection demand past max_connections.",
        category: "deployment",
        confidence: "high",
        supportingEvidence: supporting,
        contradictingEvidence: [],
        reasoning: "Deploy at T-6, pool timeouts from T-1, Postgres refusing connections at T+1.",
        nextChecks: ["Roll back to v2.13.4"],
      },
    ],
    timeline: [{ at: minutesAgo(16).toISOString(), kind: "deployment", title: "v2.14.0 deployed", evidenceIds: supporting.slice(0, 1) }],
    openQuestions: [],
  });

describe("the Claude agent", () => {
  it("gathers evidence through tools, then submits findings whose invented citations are removed", async () => {
    const { client, requests } = fakeClient([
      {
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          toolUse("t1", "list_deployments", { service: "checkout-api", from: null, to: null }),
          toolUse("t2", "search_logs", { service: null, min_level: "error", query: null, from: null, to: null }),
          toolUse("t3", "list_deployments", { service: "other-api", from: null, to: null }), // another tenant's
        ],
      },
      { content: [submit([`deploy:${ids.deploy}`, "deploy:424242"])] },
    ]);
    const id = await queued(createClaudeInvestigator({ client }));
    await runInvestigation(ctx, id);
    const r = await row(id);
    expect(r).toMatchObject({ status: "completed", provider: "claude", model: "claude-opus-5-5" });
    expect(r.findings.hypotheses[0].supportingEvidence).toEqual([`deploy:${ids.deploy}`]);
    expect(r.warnings).toEqual([expect.stringMatching(/never retrieved \(hypothesis 1\): deploy:424242/)]);
    expect(r.steps.map((s: { tool: string }) => s.tool)).toEqual(["list_deployments", "search_logs", "list_deployments", "submit_findings"]);
    expect(r.usage).toMatchObject({ requests: 2, inputTokens: 200, outputTokens: 100 });

    // The request: model, server-side fallback, strict tools, the fenced brief.
    const first = requests[0];
    expect(first).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium" } });
    expect(first.tools.map((t: { name: string; strict: boolean }) => [t.name, t.strict])).toEqual(INVESTIGATOR_TOOLS.map((t) => [t.name, true]));
    expect(first.tools.every((t: { input_schema: Record<string, unknown> }) => t.input_schema.additionalProperties === false && !("$schema" in t.input_schema))).toBe(true);
    expect(first.messages[0].content).toMatch(/<incident>[\s\S]*depends on: auth-service, postgres-primary[\s\S]*<\/incident>/);

    // The second request carries the assistant turn back unchanged (thinking
    // block included) and one tool_result per call, redacted and tenant-scoped.
    const second = requests[1];
    expect(second.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "thinking", signature: "sig" }, { id: "t1" }, { id: "t2" }, { id: "t3" }] });
    const results = second.messages[2].content as { tool_use_id: string; content: string }[];
    expect(results.map((x) => x.tool_use_id)).toEqual(["t1", "t2", "t3"]);
    expect(JSON.parse(results[0].content)[0]).toMatchObject({ version: "v2.14.0", previousVersion: "v2.13.4" });
    expect(results[1].content).toContain("[redacted]");
    expect(results[1].content).not.toContain("hunter2");
    expect(JSON.parse(results[2].content)).toEqual([]);
  });

  it("returns tool errors to the model instead of crashing, and keeps to the tool budget", async () => {
    const calls = Array.from({ length: AGENT_LIMITS.toolCalls + 2 }, (_, i) => toolUse(`c${i}`, "list_alerts", { service: null, from: null, to: null }));
    const { client, requests } = fakeClient([
      { content: [toolUse("bad", "search_logs", { service: null, min_level: "catastrophic", query: null, from: null, to: null }), toolUse("x", "drop_tables", {})] },
      { content: calls },
      { content: [submit(["alert:alert_A1"])] },
    ]);
    const id = await queued(createClaudeInvestigator({ client }));
    await runInvestigation(ctx, id);
    const second = requests[1].messages.at(-1).content;
    expect(second[0]).toMatchObject({ tool_use_id: "bad", is_error: true, content: expect.stringMatching(/Invalid input/) });
    expect(second[1]).toMatchObject({ tool_use_id: "x", is_error: true, content: "Unknown tool drop_tables" });
    const third = requests[2].messages.at(-1).content;
    expect(third.filter((x: { is_error?: boolean }) => x.is_error)).toHaveLength(3); // 16 budget - 1 used = 15 ran, 3 refused
    expect((await row(id)).status).toBe("completed");
  });

  it("nudges once when the model answers in prose, then fails permanently", async () => {
    const { client } = fakeClient([
      { content: [{ type: "text", text: "It was probably the deploy." }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "Really, the deploy." }], stop_reason: "end_turn" },
    ]);
    const id = await queued(createClaudeInvestigator({ client }));
    await expect(runInvestigation(ctx, id, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await row(id)).toMatchObject({ status: "failed", error: "The model stopped without submitting findings" });
  });

  it("fails without retrying on a refusal, and leaves transient errors to BullMQ's retries", async () => {
    const refusal = fakeClient([{ content: [], stop_reason: "refusal" }]);
    const a = await queued(createClaudeInvestigator({ client: refusal.client }));
    await expect(runInvestigation(ctx, a, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await row(a)).toMatchObject({ status: "failed", error: "The model declined to investigate this incident" });

    const flaky = fakeClient([]); // throws a plain error: like a network failure
    await pool.query(`DELETE FROM incident_investigations`);
    const b = await queued(createClaudeInvestigator({ client: flaky.client }));
    await expect(runInvestigation(ctx, b, false)).rejects.toThrow("no more scripted turns");
    expect(await row(b)).toMatchObject({ status: "queued", error: "no more scripted turns" });
  });
});
