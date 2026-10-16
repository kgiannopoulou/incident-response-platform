import { rulesInvestigator } from "../src/investigator/investigators";
import Anthropic from "@anthropic-ai/sdk";
import { Queue, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFixtures, setupTestDatabase, type Fixtures } from "@irp/database/testing";
import { aiPostmortemOutputSchema, buildAiContext, QUEUES, ruleBasedPostmortemDraft, type AiPostmortemContext, type AiPostmortemOutput } from "@irp/shared";
import type { Pool } from "pg";
import { createClaudeDrafter, PermanentDraftError, rulesDrafter, type PostmortemDrafter } from "../src/ai-drafter";
import { generateAiDraft } from "../src/ai-drafts";
import type { WorkerContext } from "../src/context";
import { sweep } from "../src/sweeper";

let pool: Pool;
let ctx: WorkerContext;
let fx: Fixtures;
let seen: AiPostmortemContext[] = [];

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
  await Promise.all([ctx.notificationsQueue, ctx.escalationsQueue, ctx.webhooksQueue, ctx.deadLetterQueue, ctx.aiDraftsQueue].map((q) => q.close()));
  await ctx.redis.quit();
  await pool.end();
});
beforeEach(async () => {
  fx = await resetFixtures(pool);
  await ctx.redis.flushdb();
  ctx.drafter = rulesDrafter;
  seen = [];
});

// A resolved checkout incident with an alert (carrying a secret), a note
// and a postmortem, plus a queued draft request for it.
async function resolvedIncidentWithDraft() {
  const { rows } = await pool.query(
    `INSERT INTO incidents (organization_id, number, service_id, title, severity, status, triggered_at, acknowledged_at, resolved_at)
     VALUES ($1, 1, $2, 'Checkout API unavailable', 'sev1', 'resolved', now() - interval '40 minutes',
             now() - interval '39 minutes', now() - interval '3 minutes') RETURNING id`,
    [fx.orgs.acme, fx.services.checkout]
  );
  const incidentId = rows[0].id as number;
  const { rows: alert } = await pool.query(
    `INSERT INTO alerts (organization_id, service_id, public_id, dedup_key, title, description, severity, source, metadata)
     VALUES ($1, $2, 'alert_01TEST', 'checkout-5xx', 'Checkout 5xx', 'seen by ops@acme.test', 'critical', 'prometheus', $3) RETURNING id`,
    [fx.orgs.acme, fx.services.checkout, JSON.stringify({ errorRate: 38, password: "hunter2" })]
  );
  await pool.query(`INSERT INTO incident_alerts (incident_id, alert_id) VALUES ($1, $2)`, [incidentId, alert[0].id]);
  for (const [type, actor, message] of [
    ["INCIDENT_CREATED", null, "Incident opened by alert from prometheus"],
    ["INCIDENT_ACKNOWLEDGED", fx.users.sam, "Acknowledged"],
    ["NOTE_ADDED", fx.users.sam, "Database connections appear exhausted"],
    ["INCIDENT_RESOLVED", fx.users.sam, "Resolved: pool size raised"],
  ] as const) {
    await pool.query(`INSERT INTO timeline_events (incident_id, event_type, actor_id, message) VALUES ($1, $2, $3, $4)`, [incidentId, type, actor, message]);
  }
  await pool.query(`INSERT INTO postmortems (incident_id) VALUES ($1)`, [incidentId]);
  const { rows: draft } = await pool.query(
    `INSERT INTO postmortem_ai_drafts (organization_id, incident_id, requested_by) VALUES ($1, $2, $3) RETURNING id`,
    [fx.orgs.acme, incidentId, fx.users.sam]
  );
  const { rows: events } = await pool.query(`SELECT id FROM timeline_events WHERE incident_id = $1 ORDER BY id`, [incidentId]);
  return { incidentId, draftId: draft[0].id as number, eventIds: events.map((e) => e.id as number) };
}

const draftRow = async (id: number) => (await pool.query(`SELECT * FROM postmortem_ai_drafts WHERE id = $1`, [id])).rows[0];

// A stand-in for the model: records what it was given, answers `output`.
function fakeDrafter(output: (context: AiPostmortemContext) => AiPostmortemOutput | Promise<AiPostmortemOutput>): PostmortemDrafter {
  return {
    provider: "claude",
    model: "claude-opus-5-5",
    async draft(context) {
      seen.push(context);
      return { output: await output(context), model: "claude-opus-5-5", usage: { inputTokens: 1200, outputTokens: 400 } };
    },
  };
}

describe("generateAiDraft", () => {
  it("drafts from the source tables, redacted, and stores a validated suggestion", async () => {
    const { draftId, eventIds } = await resolvedIncidentWithDraft();
    ctx.drafter = fakeDrafter(ruleBasedPostmortemDraft);
    await generateAiDraft(ctx, draftId);

    const context = seen[0];
    expect(context.timeline.map((e) => e.eventId)).toEqual(eventIds);
    expect(JSON.stringify(context)).not.toMatch(/hunter2|ops@acme\.test/);

    const row = await draftRow(draftId);
    expect(row).toMatchObject({ status: "ready", provider: "claude", model: "claude-opus-5-5", attempts: 1, input_events: 4, error: null });
    expect(row.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.usage).toEqual({ inputTokens: 1200, outputTokens: 400 });
    expect(row.output.probableRootCause.evidenceEventIds).toEqual([eventIds[2]]); // the note

    // The postmortem itself is untouched: applying is a person's decision.
    const { rows: pm } = await pool.query(`SELECT summary, ai_assisted_sections FROM postmortems`);
    expect(pm[0]).toEqual({ summary: "", ai_assisted_sections: [] });
  });

  it("strips citations the model invented and records a warning", async () => {
    const { draftId } = await resolvedIncidentWithDraft();
    ctx.drafter = fakeDrafter((c) => ({
      ...ruleBasedPostmortemDraft(c),
      probableRootCause: { statement: "A bad deploy.", confidence: "high", evidenceEventIds: [987654] },
    }));
    await generateAiDraft(ctx, draftId);
    const row = await draftRow(draftId);
    expect(row.output.probableRootCause.evidenceEventIds).toEqual([]);
    expect(row.warnings.map((w: { message: string }) => w.message)).toContain(
      "Removed citations of events that are not in this incident's timeline: 987654."
    );
  });

  it("fails at once, without retries, on a permanent error", async () => {
    const { draftId } = await resolvedIncidentWithDraft();
    ctx.drafter = fakeDrafter(() => {
      throw new PermanentDraftError("The model declined to draft this postmortem");
    });
    await expect(generateAiDraft(ctx, draftId, false)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await draftRow(draftId)).toMatchObject({ status: "failed", error: "The model declined to draft this postmortem" });
  });

  it("goes back to queued on a transient error, and fails on the last attempt", async () => {
    const { draftId } = await resolvedIncidentWithDraft();
    ctx.drafter = fakeDrafter(() => {
      throw new Error("529 overloaded");
    });
    await expect(generateAiDraft(ctx, draftId, false)).rejects.toThrow("529 overloaded");
    expect(await draftRow(draftId)).toMatchObject({ status: "queued", error: "529 overloaded", attempts: 1 });
    await expect(generateAiDraft(ctx, draftId, true)).rejects.toThrow("529 overloaded");
    expect(await draftRow(draftId)).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("leaves discarded or finished drafts alone (idempotent job)", async () => {
    const { draftId } = await resolvedIncidentWithDraft();
    await pool.query(`UPDATE postmortem_ai_drafts SET status = 'discarded' WHERE id = $1`, [draftId]);
    ctx.drafter = fakeDrafter(ruleBasedPostmortemDraft);
    expect(await generateAiDraft(ctx, draftId)).toEqual({ skipped: true });
    expect(seen).toHaveLength(0);
  });

  it("is recovered by the sweeper when its job was lost, and given up when a worker died mid-draft", async () => {
    const { draftId, incidentId } = await resolvedIncidentWithDraft();
    await pool.query(`UPDATE postmortem_ai_drafts SET created_at = now() - interval '5 minutes' WHERE id = $1`, [draftId]);
    await sweep(ctx);
    expect(await ctx.aiDraftsQueue.getJob(`ai-draft-${draftId}`)).toBeTruthy();

    await pool.query(`UPDATE postmortem_ai_drafts SET status = 'discarded' WHERE id = $1`, [draftId]);
    const { rows } = await pool.query(
      `INSERT INTO postmortem_ai_drafts (organization_id, incident_id, status, started_at)
       VALUES ($1, $2, 'generating', now() - interval '15 minutes') RETURNING id`,
      [fx.orgs.acme, incidentId]
    );
    await sweep(ctx);
    expect(await draftRow(rows[0].id)).toMatchObject({ status: "failed", error: expect.stringMatching(/worker stopped/) });
  });
});

describe("Claude drafter", () => {
  const opened = new Date("2026-10-10T14:02:00Z");
  const context = buildAiContext({
    incident: { number: 1, title: "Checkout down", severity: "sev1", serviceName: "Checkout API", status: "resolved", triggeredAt: opened, acknowledgedAt: null, mitigatedAt: null, resolvedAt: opened },
    metrics: { timeToAcknowledgeSeconds: null, timeToMitigateSeconds: 0, timeToResolveSeconds: 0, escalations: 0, ackTimeouts: 0 },
    alerts: [],
    responders: [],
    timeline: [{ id: 1, createdAt: opened, type: "INCIDENT_CREATED", actorName: null, message: "opened" }],
  });

  function fakeClient(response: object | Error) {
    const parse = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
  }

  it("asks for structured output matching the schema, with a server-side fallback", async () => {
    const output = ruleBasedPostmortemDraft(context);
    const { client, parse } = fakeClient({
      stop_reason: "end_turn",
      parsed_output: output,
      model: "claude-opus-5-5",
      usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0 },
    });
    const result = await createClaudeDrafter({ client }).draft(context);
    expect(result).toMatchObject({ output, model: "claude-opus-5-5", usage: { inputTokens: 900, outputTokens: 300 } });

    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "medium", format: expect.objectContaining({ type: "json_schema" }) },
    });
    expect(JSON.stringify(params.messages)).toContain("<incident_data>");
    expect(aiPostmortemOutputSchema.safeParse(output).success).toBe(true);
  });

  it("turns refusals, truncation and bad keys into permanent failures", async () => {
    const cases: [object | Error, RegExp][] = [
      [{ stop_reason: "refusal", parsed_output: null, usage: {} }, /declined/],
      [{ stop_reason: "max_tokens", parsed_output: null, usage: {} }, /cut off/],
      [{ stop_reason: "end_turn", parsed_output: null, usage: {} }, /did not match/],
      [new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()), /API key/],
    ];
    for (const [response, message] of cases) {
      const { client } = fakeClient(response);
      const attempt = createClaudeDrafter({ client }).draft(context);
      await expect(attempt).rejects.toBeInstanceOf(PermanentDraftError);
      await expect(attempt).rejects.toThrow(message);
    }
  });

  it("lets rate limits and overload errors through for BullMQ to retry", async () => {
    const { client } = fakeClient(new Anthropic.RateLimitError(429, { error: { message: "slow down" } }, "slow down", new Headers()));
    await expect(createClaudeDrafter({ client }).draft(context)).rejects.toBeInstanceOf(Anthropic.RateLimitError);
  });
});
