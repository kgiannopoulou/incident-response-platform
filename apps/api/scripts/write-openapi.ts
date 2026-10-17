// Writes docs/openapi.json from src/openapi.ts. test/openapi.test.ts fails
// when the committed file is out of date, so run this after changing routes.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../src/openapi";

const target = fileURLToPath(new URL("../../../docs/openapi.json", import.meta.url));
writeFileSync(target, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`wrote ${target}`);
