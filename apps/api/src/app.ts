import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import type { Deps } from "./deps";
import { requireAuth } from "./lib/auth";
import { errorHandler } from "./lib/http";
import { alertsRouter } from "./routes/alerts";
import { authRouter } from "./routes/auth";
import { incidentsRouter } from "./routes/incidents";
import { orgRouter } from "./routes/org";
import { servicesRouter } from "./routes/services";

// Builds the Express app from injected dependencies (see deps.ts), so tests
// can run it in-process against a test database without listening on a port.
export function createApp(deps: Deps) {
  const app = express();
  app.disable("x-powered-by");
  if (deps.trustProxy !== undefined) app.set("trust proxy", deps.trustProxy);
  app.use(cors({ origin: deps.webOrigin, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_req, res) => {
    const [db, redis] = await Promise.allSettled([deps.pool.query("SELECT 1"), deps.redis.ping()]);
    const ok = db.status === "fulfilled" && redis.status === "fulfilled";
    res.status(ok ? 200 : 503).json({
      ok,
      postgres: db.status === "fulfilled" ? "up" : "down",
      redis: redis.status === "fulfilled" ? "up" : "down",
      sseClients: deps.hub.connectionCount,
    });
  });

  const v1 = express.Router();
  v1.use("/auth", authRouter(deps));
  v1.use("/alerts", alertsRouter(deps)); // ingestion uses integration keys, the feed uses sessions
  v1.use(requireAuth(deps.jwtSecret));
  v1.use("/incidents", incidentsRouter(deps));
  v1.use("/services", servicesRouter(deps));
  v1.use("/", orgRouter(deps));
  app.use("/api/v1", v1);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
