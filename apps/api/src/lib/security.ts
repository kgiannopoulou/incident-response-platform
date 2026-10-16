import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { SESSION_COOKIE } from "./auth";
import { HttpError } from "./http";

// HTTP hardening for a JSON API (Phase 24). The API never serves HTML, so the
// strictest policies apply: nothing may be loaded or framed from a response.
export function securityHeaders(options: { hsts: boolean }) {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] } },
    // Responses are read cross-origin by the web app (CORS allows exactly
    // WEB_ORIGIN), so cross-origin *embedding* rules must not block them.
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: options.hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
}

// Authenticated responses (incidents, people, audit log) must not be stored
// by browsers or shared caches.
export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF protection for cookie-authenticated requests.
//
// The browser session is an httpOnly, SameSite=Strict cookie, which already
// stops cross-site requests from carrying it in modern browsers. As defence
// in depth (older browsers, same-site subdomains, a future SameSite change),
// every state-changing request that authenticates with the cookie must come
// from the web app's own origin — checked on the Origin header (or Referer
// when a browser omits Origin), as OWASP recommends for APIs.
//
// Requests authenticated with `Authorization: Bearer` (scripts, API keys)
// aren't affected: a malicious page can't make a browser attach that header.
// Login has no cookie yet, but is checked too (login CSRF).
export function csrfProtection(webOrigin: string) {
  const allowed = new URL(webOrigin).origin;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const usesCookie = Boolean(req.cookies?.[SESSION_COOKIE]) && !req.headers.authorization;
    const isLogin = req.path === "/api/v1/auth/login";
    if (!usesCookie && !isLogin) return next();

    const origin = req.get("origin") ?? refererOrigin(req.get("referer"));
    // Login from curl / scripts (no Origin, no cookie) is fine; a browser
    // always sends Origin on a cross-origin POST.
    if (!origin && isLogin && !usesCookie) return next();
    if (origin !== allowed) {
      return next(new HttpError(403, "Cross-site request refused (Origin does not match the web app)"));
    }
    next();
  };
}

function refererOrigin(referer: string | undefined) {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

// Placeholder / example values that must never sign real sessions.
const KNOWN_PLACEHOLDERS = [
  "change-me-to-a-long-random-string",
  "docker-demo-secret-change-me-0123456789abcdef",
  "docker-demo-secret-change-me",
  "secret",
  "changeme",
];

// Session tokens are HMAC-signed with JWT_SECRET, so a guessable secret lets
// anyone mint an admin session for any organization. A real installation
// (DEMO_ENABLED=false) refuses to start with a short or known placeholder
// secret; the demo setup only warns, so `docker compose up` works out of the box.
export function checkJwtSecret(secret: string, { demo }: { demo: boolean }) {
  const problem =
    secret.length < 32
      ? `JWT_SECRET is only ${secret.length} characters (need at least 32)`
      : KNOWN_PLACEHOLDERS.includes(secret)
        ? "JWT_SECRET is the example value from .env.example / docker-compose.yml"
        : null;
  if (!problem) return { ok: true as const };
  const fix = "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"";
  if (demo) return { ok: true as const, warning: `${problem}. Fine for the local demo, never for real data. ${fix}` };
  return { ok: false as const, error: `${problem}. Refusing to start with DEMO_ENABLED=false. ${fix}` };
}

// A coarse flood guard in front of every API route: at most `perMinute`
// requests per credential (API key, session token or cookie — hashed) or,
// without one, per client IP. It sits above the finer limits (per-key token
// bucket for ingestion, login throttling) and stops one script or stuck
// dashboard from monopolising the API. In-memory per API instance: it guards
// the process, it isn't a quota.
export function floodGuard(perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const credential = req.headers.authorization ?? req.cookies?.[SESSION_COOKIE];
      return credential ? `c:${createHash("sha256").update(credential).digest("base64url").slice(0, 22)}` : `ip:${req.ip}`;
    },
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests; slow down" });
    },
  });
}
