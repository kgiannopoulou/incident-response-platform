import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import type { Deps } from "./deps";
import { requireAdmin, requireAuth } from "./lib/auth";
import { errorHandler } from "./lib/http";
import { IngestionStats } from "./lib/ingestion-stats";
import { withTimeout } from "./lib/resilience";
import { csrfProtection, floodGuard, noStore, securityHeaders } from "./lib/security";
import { buildOpenApi } from "./openapi";
import { adminRouter, liveWorkers } from "./routes/admin";
import { alertsRouter } from "./routes/alerts";
import { authRouter } from "./routes/auth";
import { demoRouter } from "./routes/demo";
import { escalationPoliciesRouter } from "./routes/escalation-policies";
import { incidentsRouter } from "./routes/incidents";
import { investigationsRouter } from "./routes/investigations";
import { metricsRouter } from "./routes/metrics";
import { orgRouter } from "./routes/org";
import { postmortemListRouter, postmortemRouter } from "./routes/postmortems";
import { servicesRouter } from "./routes/services";
import { deploymentsRouter, logsRouter } from "./routes/telemetry";
import { webhooksRouter } from "./routes/webhooks";

// Builds the Express app from injected dependencies (see deps.ts), so tests
// can run it in-process against a test database without listening on a port.
export function createApp(given: Deps) {
  const deps: Deps = { ...given, ingestionStats: given.ingestionStats ?? new IngestionStats() };
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy !== undefined) app.set("trust proxy", deps.trustProxy);
  app.use(securityHeaders({ hsts: deps.secureCookies }));
  // Only the web app may call the API from a browser with credentials.
  app.use(cors({ origin: deps.webOrigin, credentials: true, maxAge: 600 }));
  app.use(cookieParser());
  app.use(csrfProtection(deps.webOrigin));
  // Bodies are JSON only and small: alerts, notes, policies. A form-encoded
  // or text/plain body (what a cross-site <form> can send) is never parsed.
  app.use(express.json({ limit: "256kb" }));

  // Liveness: the process is up and serving. Container orchestrators restart
  // the API only when this fails — never because a dependency is down, which
  // a restart wouldn't fix.
  app.get("/health/live", (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness / status. Each dependency check has a deadline, so the endpoint
  // answers within ~2 s even while Postgres or Redis hangs.
  //   postgres down -> 503: alerts can't be accepted (Postgres is the source of truth).
  //   redis down    -> 200 with "degraded": alerts are still accepted and
  //                    paged by the worker's sweeper once Redis is back.
  app.get("/health", floodGuard(deps.floodGuardPerMinute ?? 1200), async (_req, res) => {
    const [db, redis, workers] = await Promise.allSettled([
      withTimeout(deps.pool.query("SELECT 1"), 2_000, "postgres"),
      withTimeout(deps.redis.ping(), 1_000, "redis"),
      withTimeout(liveWorkers(deps), 1_000, "workers"),
    ]);
    const postgresUp = db.status === "fulfilled";
    const redisUp = redis.status === "fulfilled";
    res.status(postgresUp ? 200 : 503).json({
      ok: postgresUp && redisUp,
      status: !postgresUp ? "unavailable" : redisUp ? "ok" : "degraded",
      acceptingAlerts: postgresUp,
      postgres: postgresUp ? "up" : "down",
      redis: redisUp ? "up" : "down",
      sseClients: deps.hub.connectionCount,
      // Background workers with a fresh heartbeat. 0 doesn't fail the check —
      // the API still accepts alerts; pages wait in Postgres until one is back.
      workers: workers.status === "fulfilled" ? workers.value.length : null,
    });
  });

  const v1 = express.Router();
  v1.use(floodGuard(deps.floodGuardPerMinute ?? 1200));
  v1.use(noStore);
  const openApi = buildOpenApi();
  v1.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });
  v1.use("/auth", authRouter(deps));
  v1.use("/alerts", alertsRouter(deps)); // ingestion uses integration keys, the feed uses sessions
  v1.use("/deployments", deploymentsRouter(deps)); // same: CI/CD reports with keys, the list uses sessions
  v1.use("/logs", logsRouter(deps));
  v1.use(requireAuth(deps.jwtSecret));
  v1.use("/incidents/:number/postmortem", postmortemRouter(deps));
  v1.use("/incidents/:number/investigations", investigationsRouter(deps));
  v1.use("/incidents", incidentsRouter(deps));
  v1.use("/postmortems", postmortemListRouter(deps));
  v1.use("/metrics", metricsRouter(deps));
  v1.use("/demo", demoRouter(deps));
  v1.use("/services", servicesRouter(deps));
  v1.use("/escalation-policies", escalationPoliciesRouter(deps));
  v1.use("/admin", requireAdmin, adminRouter(deps));
  v1.use("/webhooks", webhooksRouter(deps));
  v1.use("/", orgRouter(deps));
  app.use("/api/v1", v1);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
