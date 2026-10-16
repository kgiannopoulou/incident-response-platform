// Pure parts of the incident demo (unit tested): argument parsing, the clock
// format and the responders' script.

export type DemoArgs = { speed: number; respond: boolean };

export function parseArgs(argv: string[]): DemoArgs {
  const args: DemoArgs = { speed: 1, respond: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--respond") args.respond = true;
    else if (arg === "--speed" || arg.startsWith("--speed=")) {
      const value = Number(arg.includes("=") ? arg.split("=")[1] : argv[++i]);
      if (!(value > 0 && value <= 20)) throw new Error("--speed must be a number between 0 and 20");
      args.speed = value;
    } else throw new Error(`Unknown option ${arg} (use --speed <n> and/or --respond)`);
  }
  return args;
}

// 75 → "01:15"
export const formatClock = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export type ResponseStep =
  | { at: number; who: string; label: string; kind: "api" | "draft"; method: string; path: string; body?: unknown; number: number }
  | { at: number; who: string; label: string; kind: "clear-alerts"; keys: [service: string, dedupKey: string][] };

// What the people do once the alerts have fired. `opened` maps the
// scenario's deduplication keys to the incident numbers they opened.
export function planResponse(opened: Map<string, number>, alertsEndAt: number): ResponseStep[] {
  const checkout = opened.get("checkout-errors");
  const database = opened.get("pg-connections");
  const latency = opened.get("checkout-latency");
  const at = (offset: number) => alertsEndAt + offset;
  const steps: ResponseStep[] = [];
  const api = (offset: number, label: string, number: number, method: string, path: string, body?: unknown, kind: "api" | "draft" = "api") =>
    steps.push({ at: at(offset), who: "Sam", label, kind, method, path: `/incidents/${number}${path}`, body, number });

  if (checkout) {
    api(3, `acknowledges INC-${checkout}`, checkout, "POST", "/acknowledge");
    api(6, "starts investigating", checkout, "POST", "/status", { status: "investigating" });
    api(7, "runs the incident investigator", checkout, "POST", "/investigations");
    api(9, 'notes "Database connections appear exhausted (500/500)"', checkout, "POST", "/notes", {
      message: "Database connections appear exhausted (500/500) — checkout requests time out waiting for a connection",
    });
    if (database) api(11, `links INC-${database}: same root cause`, database, "POST", "/notes", { message: `Same root cause as INC-${checkout}` });
    api(15, 'notes "Rolled back checkout-api to v2.13.4"', checkout, "POST", "/notes", {
      message: "Rolled back checkout-api to v2.13.4 (worker concurrency back to 8 per pod); database connections draining",
    });
    api(18, "marks it mitigated", checkout, "POST", "/status", { status: "mitigated", message: "Error rate back under 1%" });
  }
  steps.push({
    at: at(23),
    who: "monitor",
    label: "monitoring clears the alerts",
    kind: "clear-alerts",
    keys: [
      ["checkout-api", "checkout-errors"],
      ["checkout-api", "checkout-latency"],
      ["postgres-primary", "pg-connections"],
    ],
  });
  for (const number of [checkout, latency, database]) {
    if (number) api(26, `resolves INC-${number}`, number, "POST", "/status", { status: "resolved", message: "v2.14.0 rolled back; connections and error rate normal" });
  }
  if (checkout) api(29, "asks for an AI postmortem draft", checkout, "POST", "/postmortem/ai-drafts", undefined, "draft");
  return steps;
}
