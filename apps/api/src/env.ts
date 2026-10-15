// Importing @irp/database loads the root .env first.
import { databaseUrl } from "@irp/database";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  databaseUrl: databaseUrl(),
  redisUrl: required("REDIS_URL"),
  jwtSecret: required("JWT_SECRET"),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  // Set COOKIE_SECURE=true when serving over HTTPS.
  secureCookies: process.env.COOKIE_SECURE === "true",
  // Failed API-key authentications allowed per client IP per minute.
  authFailuresPerMinute: Number(process.env.AUTH_FAILURES_PER_MINUTE ?? 20),
  // The dashboard's incident simulator; turn off on a real installation.
  demoEnabled: process.env.DEMO_ENABLED !== "false",
  // e.g. "1" behind one reverse proxy; unset = use the socket address.
  trustProxy: process.env.TRUST_PROXY
    ? /^\d+$/.test(process.env.TRUST_PROXY)
      ? Number(process.env.TRUST_PROXY)
      : process.env.TRUST_PROXY
    : undefined,
};
