import { Router } from "express";
import { z } from "zod";
import {
  alertPayloadSchema,
  DEMO_SPEEDS,
  PRODUCTION_INCIDENT,
  simulatedAlert,
  type DemoRunState,
  type DemoScenario,
} from "@irp/shared";
import { publishRealtime } from "@irp/shared/realtime";
import type { Deps } from "../deps";
import { ingestAlert, type IngestService } from "../domain/ingestion";
import { audit } from "../lib/audit";
import { requireAdmin } from "../lib/auth";
import { HttpError } from "../lib/http";

// The dashboard's "Simulate production incident" button.
//
//   GET  /demo           the scenario and the organization's current run, if any
//   POST /demo/simulate  { speed?: 1 | 2 | 5 }  → 202, then the alerts arrive over ~15 s
//
// The alerts go through the real ingestion pipeline (dedup, rules,
// incidents, paging, realtime) as if each service's monitoring had sent
// them — only the HTTP/API-key hop is skipped. Each alert is tagged
// metadata.simulated. One run at a time per organization (a Redis lock that
// also holds the progress, so a page opened mid-run can show it).
//
// The run lives in this API process (timers). If the process restarts mid-run
// the remaining steps are lost, which is fine for a demo; anything already
// ingested is in Postgres like any other alert. Disable with DEMO_ENABLED=false.

const bodySchema = z.object({
  speed: z.coerce
    .number()
    .refine((s) => (DEMO_SPEEDS as readonly number[]).includes(s), "speed must be 1, 2 or 5")
    .default(1),
});

export const demoKey = (organizationId: number) => `irp:demo:org:${organizationId}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Plays a scenario; resolves when the last step has been ingested.
export async function runScenario(
  deps: Pick<Deps, "pool" | "redis" | "queues">,
  organizationId: number,
  scenario: DemoScenario,
  state: DemoRunState,
  timeScale = 1000 // ms per scenario second at speed 1; tests pass 0
) {
  const key = demoKey(organizationId);
  const { rows: services } = await deps.pool.query<IngestService>(
    `SELECT id, organization_id, name, slug, status, auto_resolve FROM services WHERE organization_id = $1`,
    [organizationId]
  );
  const bySlug = new Map(services.map((s) => [s.slug, s]));
  const started = Date.now();

  for (const step of scenario.steps) {
    const wait = started + (step.at * timeScale) / state.speed - Date.now();
    if (wait > 0) await sleep(wait);
    const service = bySlug.get(step.alert.service);
    let result: DemoRunState["results"][number];
    if (!service) {
      result = { label: step.label, decision: `skipped (no service "${step.alert.service}")`, incident: null };
    } else {
      try {
        const payload = alertPayloadSchema.parse(simulatedAlert(step, state.runId));
        const ingested = await ingestAlert(deps, service, null, payload);
        result = { label: step.label, decision: ingested.decision, incident: ingested.incident?.number ?? null };
      } catch (err) {
        result = { label: step.label, decision: `failed: ${(err as Error).message}`, incident: null };
      }
    }
    state.step++;
    state.label = step.label;
    state.results.push(result);
    state.done = state.step === state.total;
    await deps.redis.set(key, JSON.stringify(state), "KEEPTTL");
    await publishRealtime(deps.redis, organizationId, {
      type: "demo.progress",
      runId: state.runId,
      step: state.step,
      total: state.total,
      label: step.label,
      done: state.done,
    }).catch(() => undefined);
  }
  // Keep the finished run visible for a minute, then free the lock.
  await deps.redis.set(key, JSON.stringify(state), "EX", 60);
  return state;
}

export function demoRouter(deps: Deps) {
  const router = Router();
  const enabled = deps.demo?.enabled ?? true;

  router.get("/", async (req, res) => {
    const raw = await deps.redis.get(demoKey(req.user!.organizationId));
    res.json({
      enabled,
      scenario: { ...PRODUCTION_INCIDENT, steps: PRODUCTION_INCIDENT.steps.map((s) => ({ at: s.at, label: s.label })) },
      run: raw ? (JSON.parse(raw) as DemoRunState) : null,
    });
  });

  router.post("/simulate", requireAdmin, async (req, res) => {
    if (!enabled) throw new HttpError(404, "The simulator is disabled on this installation");
    const { speed } = bodySchema.parse(req.body ?? {});
    const orgId = req.user!.organizationId;
    const scenario = PRODUCTION_INCIDENT;
    const state: DemoRunState = {
      runId: `demo_${Date.now().toString(36)}`,
      scenario: scenario.id,
      startedBy: req.user!.name,
      startedAt: new Date().toISOString(),
      speed,
      step: 0,
      total: scenario.steps.length,
      label: "",
      done: false,
      results: [],
    };
    const ttl = Math.ceil(Math.max(...scenario.steps.map((s) => s.at)) / speed) + 120;
    const locked = await deps.redis.set(demoKey(orgId), JSON.stringify(state), "EX", ttl, "NX");
    if (!locked) throw new HttpError(409, "A simulation is already running");

    await audit(deps.pool, {
      organizationId: orgId,
      actorUserId: req.user!.id,
      action: "demo.simulate",
      entityType: "organization",
      entityId: orgId,
      details: { runId: state.runId, scenario: scenario.id, speed },
    });
    // Not awaited: the steps play out over the next seconds.
    runScenario(deps, orgId, scenario, state, deps.demo?.timeScale).catch(async (err) => {
      console.error("Simulation failed:", err);
      await deps.redis.del(demoKey(orgId)).catch(() => 0);
    });
    res.status(202).json({ run: state, steps: scenario.steps.map((s) => ({ at: s.at, label: s.label })) });
  });

  return router;
}
