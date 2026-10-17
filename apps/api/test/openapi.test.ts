import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpenApi, OPERATIONS } from "../src/openapi";
import { createTestContext, type TestContext } from "./helpers";

// The OpenAPI document is hand-listed (one line per route) with bodies
// generated from the zod schemas. These tests keep the list honest: every
// route the app registers is documented, nothing documented is missing from
// the app, and docs/openapi.json is what `npm run openapi` would write.

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

// "METHOD /path" for every route in routes/*.ts, prefixed with where app.ts
// mounts the router function that registers it.
function registeredRoutes() {
  const mounts = new Map<string, string>();
  for (const [, prefix, fn] of src("app.ts").matchAll(/v1\.use\("([^"]+)",\s*(?:requireAdmin,\s*)?(\w+)\(deps\)\)/g)) {
    mounts.set(fn, prefix === "/" ? "" : prefix);
  }
  const routes: string[] = [];
  for (const file of readdirSync(fileURLToPath(new URL("../src/routes", import.meta.url)))) {
    let current: string | undefined;
    for (const line of src(`routes/${file}`).split("\n")) {
      const fn = line.match(/^export function (\w+)\(/)?.[1];
      if (fn) current = fn;
      const route = line.match(/^\s+router\.(get|post|put|patch|delete)\("([^"]*)"/);
      if (!route) continue;
      const prefix = current && mounts.get(current);
      if (prefix === undefined) throw new Error(`${file}: route ${route[2]} in ${current}, which app.ts doesn't mount`);
      routes.push(`${route[1].toUpperCase()} ${(prefix + route[2]).replace(/\/$/, "") || "/"}`);
    }
  }
  if (/v1\.get\("\/openapi\.json"/.test(src("app.ts"))) routes.push("GET /openapi.json");
  return routes.sort();
}

describe("OpenAPI document", () => {
  it("documents exactly the routes the app registers", () => {
    const documented = OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`).sort();
    const registered = registeredRoutes();
    expect(registered.length).toBeGreaterThan(60);
    expect(documented).toEqual(registered);
  });

  it("has unique operation ids and request bodies generated from the zod schemas", () => {
    const spec = buildOpenApi();
    const ops = Object.values(spec.paths).flatMap((methods) => Object.values(methods)) as { operationId: string }[];
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
    const alert = spec.paths["/alerts"].post as { requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> } };
    expect(Object.keys(alert.requestBody.content["application/json"].schema.properties)).toEqual(
      expect.arrayContaining(["severity", "title", "deduplicationKey", "metadata", "action"])
    );
  });

  it("is committed up to date (run `npm run openapi` after changing routes)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../../../docs/openapi.json", import.meta.url)), "utf8");
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});

describe("GET /api/v1/openapi.json", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(() => t.close());

  it("is served without authentication", async () => {
    const res = await request(t.app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ openapi: "3.1.0", info: { title: expect.stringContaining("Fireline") } });
  });
});
