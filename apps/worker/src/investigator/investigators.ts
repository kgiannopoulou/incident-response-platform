import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  analyzeEvidence,
  buildInvestigatorBrief,
  INVESTIGATOR_SYSTEM_PROMPT,
  investigationFindingsSchema,
  LOG_LEVELS,
  validateFindings,
  type InvestigationFindings,
} from "@irp/shared";
import type { EvidenceStore } from "./evidence";

// Two ways to investigate an incident:
//
//   claude — an agent: Claude decides which evidence to pull through
//            read-only tools (alerts, deployments, logs, dependencies, other
//            incidents, the timeline), then submits structured findings.
//   rules  — the deterministic correlation in analyzeEvidence(), offline and
//            free; labelled as rules in the UI, never as AI.
//
// Either way the findings are validated against the store's ledger: a
// citation of evidence the investigator never retrieved is removed.

export type InvestigationStep = { tool: string; input: Record<string, unknown>; results: number; ms: number; error?: string };

export type InvestigationResult = {
  findings: InvestigationFindings;
  warnings: string[];
  steps: InvestigationStep[];
  model: string | null;
  usage?: Record<string, number>;
};

export type Investigator = {
  provider: "claude" | "rules";
  model: string | null;
  investigate(store: EvidenceStore): Promise<InvestigationResult>;
};

// Retrying won't help (bad key, refusal, no findings after the step budget).
export class PermanentInvestigationError extends Error {}

export const DEFAULT_INVESTIGATOR_MODEL = "claude-opus-5-5";

export const rulesInvestigator: Investigator = {
  provider: "rules",
  model: null,
  async investigate(store) {
    const started = Date.now();
    const bundle = await store.bundle();
    const steps: InvestigationStep[] = [
      { tool: "collect_evidence", input: { window: bundle.window, services: [bundle.incident.service, ...bundle.dependencies.upstream] }, results: store.ledger.size, ms: Date.now() - started },
    ];
    const raw = analyzeEvidence(bundle);
    const { findings, warnings } = validateFindings(raw, new Set(store.ledger.keys()));
    // Keep the rules' scores (validateFindings rebuilds hypotheses without them).
    findings.hypotheses.forEach((h, i) => (h.score = raw.hypotheses[i]?.score));
    return { findings, warnings, steps, model: null };
  },
};

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

const range = {
  from: z.string().nullable().describe("ISO 8601 start, or null for the incident's default window"),
  to: z.string().nullable().describe("ISO 8601 end, or null for the incident's default window"),
};
const TOOL_INPUTS = {
  list_alerts: z.strictObject({ service: z.string().nullable().describe("Service slug, or null for every service"), ...range }),
  list_deployments: z.strictObject({ service: z.string().nullable().describe("Service slug, or null for every service"), ...range }),
  search_logs: z.strictObject({
    service: z.string().nullable().describe("Service slug, or null for every service"),
    min_level: z.enum(LOG_LEVELS).nullable().describe("Lowest level to include (default warn)"),
    query: z.string().nullable().describe("Case-insensitive substring to match in messages, or null"),
    ...range,
  }),
  get_service_dependencies: z.strictObject({ service: z.string().describe("Service slug") }),
  list_related_incidents: z.strictObject({ ...range }),
  get_incident_timeline: z.strictObject({}),
  submit_findings: investigationFindingsSchema,
};
type ToolName = keyof typeof TOOL_INPUTS;

const DESCRIPTIONS: Record<ToolName, string> = {
  list_alerts:
    "Alerts in a time range, grouped by service and title: first/last time, count, worst severity, incident number. Use it to see what fired, where, and in what order.",
  list_deployments:
    "Deployments and other changes (config pushes, migrations, feature flags, rollbacks) in a time range, with version, previous version, author, description and status.",
  search_logs:
    "Application log patterns in a time range: messages grouped by fingerprint (numbers and ids masked), with count, first/last time and a baseline count from the equally long window before. isNew = never seen in the baseline. Most frequent first, max 25.",
  get_service_dependencies: "Which services a service depends on (upstream) and which depend on it (downstream).",
  list_related_incidents: "Other incidents of the organization that were open during the time range.",
  get_incident_timeline: "This incident's timeline: status changes, escalations, pages, notes from responders.",
  submit_findings:
    "Submit your final findings: ranked hypotheses that cite evidence ids, the reconstructed timeline and open questions. Call exactly once, at the end.",
};

function jsonSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}

export const INVESTIGATOR_TOOLS: Anthropic.Beta.BetaTool[] = (Object.keys(TOOL_INPUTS) as ToolName[]).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  input_schema: jsonSchema(TOOL_INPUTS[name]),
  strict: true,
}));

export const AGENT_LIMITS = { turns: 10, toolCalls: 16, resultChars: 15_000 };

async function runTool(store: EvidenceStore, name: Exclude<ToolName, "submit_findings">, input: unknown): Promise<unknown[] | object> {
  switch (name) {
    case "list_alerts": {
      const i = TOOL_INPUTS.list_alerts.parse(input);
      return store.alerts(i);
    }
    case "list_deployments": {
      const i = TOOL_INPUTS.list_deployments.parse(input);
      return store.deployments(i);
    }
    case "search_logs": {
      const i = TOOL_INPUTS.search_logs.parse(input);
      return store.logs({ ...i, minLevel: i.min_level });
    }
    case "get_service_dependencies": {
      const i = TOOL_INPUTS.get_service_dependencies.parse(input);
      return store.dependencies(i.service);
    }
    case "list_related_incidents":
      return store.relatedIncidents(TOOL_INPUTS.list_related_incidents.parse(input));
    case "get_incident_timeline":
      return store.timeline();
  }
}

export function createClaudeInvestigator(options: { apiKey?: string; model?: string; client?: Anthropic; effort?: "low" | "medium" | "high" } = {}): Investigator {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 2 });
  const model = options.model ?? DEFAULT_INVESTIGATOR_MODEL;
  return {
    provider: "claude",
    model,
    async investigate(store) {
      const steps: InvestigationStep[] = [];
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, requests: 0 };
      let answeredBy: string | null = null;
      const dependencies = await store.dependencies();
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        { role: "user", content: buildInvestigatorBrief(store.brief, dependencies, store.window) },
      ];
      let toolCalls = 0;
      let nudged = false;

      for (let turn = 0; turn < AGENT_LIMITS.turns; turn++) {
        let response: Anthropic.Beta.BetaMessage;
        try {
          response = await client.beta.messages.create({
            model,
            max_tokens: 16000,
            // A policy decline is retried server-side on the recommended
            // fallback model instead of failing the investigation.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: INVESTIGATOR_SYSTEM_PROMPT,
            tools: INVESTIGATOR_TOOLS,
            output_config: { effort: options.effort ?? "medium" },
            messages,
          });
        } catch (err) {
          if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            throw new PermanentInvestigationError("The AI provider rejected the API key (check ANTHROPIC_API_KEY)");
          }
          if (err instanceof Anthropic.BadRequestError) throw new PermanentInvestigationError(`The AI provider rejected the request: ${err.message}`);
          throw err; // rate limits, overload, 5xx, network: BullMQ retries the job
        }
        usage.requests++;
        usage.inputTokens += response.usage.input_tokens;
        usage.outputTokens += response.usage.output_tokens;
        usage.cacheReadInputTokens += response.usage.cache_read_input_tokens ?? 0;
        answeredBy = response.model;

        if (response.stop_reason === "refusal") throw new PermanentInvestigationError("The model declined to investigate this incident");
        if (response.stop_reason === "max_tokens") throw new PermanentInvestigationError("The investigation was cut off (max_tokens)");
        // Thinking and fallback blocks go back unchanged with the rest of the turn.
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason === "pause_turn") continue;

        const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (calls.length === 0) {
          if (nudged) throw new PermanentInvestigationError("The model stopped without submitting findings");
          nudged = true;
          messages.push({ role: "user", content: "Call submit_findings now with your findings (cite only evidence ids the tools returned)." });
          continue;
        }

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const name = call.name as ToolName;
          if (name === "submit_findings") {
            const parsed = investigationFindingsSchema.safeParse(call.input);
            if (parsed.success) {
              const { findings, warnings } = validateFindings(parsed.data, new Set(store.ledger.keys()));
              steps.push({ tool: "submit_findings", input: {}, results: findings.hypotheses.length, ms: 0 });
              return { findings, warnings, steps, model: answeredBy, usage };
            }
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid findings: ${z.prettifyError(parsed.error).slice(0, 2000)}` });
            continue;
          }
          if (!(name in TOOL_INPUTS)) {
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Unknown tool ${call.name}` });
            continue;
          }
          if (toolCalls >= AGENT_LIMITS.toolCalls) {
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Tool budget used up. Call submit_findings now with what you have." });
            continue;
          }
          toolCalls++;
          const started = Date.now();
          try {
            const value = await runTool(store, name, call.input);
            const json = JSON.stringify(value);
            steps.push({ tool: name, input: call.input as Record<string, unknown>, results: Array.isArray(value) ? value.length : 1, ms: Date.now() - started });
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: json.length > AGENT_LIMITS.resultChars ? `${json.slice(0, AGENT_LIMITS.resultChars)}… [truncated; narrow the query]` : json,
            });
          } catch (err) {
            const message = err instanceof z.ZodError ? `Invalid input: ${z.prettifyError(err)}` : (err as Error).message;
            steps.push({ tool: name, input: (call.input ?? {}) as Record<string, unknown>, results: 0, ms: Date.now() - started, error: message });
            results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: message.slice(0, 2000) });
          }
        }
        const lastTurn = turn === AGENT_LIMITS.turns - 2;
        messages.push({
          role: "user",
          content: lastTurn ? [...results, { type: "text", text: "This is your last turn: call submit_findings now." }] : results,
        });
      }
      throw new PermanentInvestigationError(`No findings were submitted within ${AGENT_LIMITS.turns} turns`);
    },
  };
}

// INVESTIGATOR_PROVIDER=claude|rules|auto (default auto: Claude when an
// ANTHROPIC_API_KEY is configured, otherwise the offline rules).
export function investigatorFromEnv(env: NodeJS.ProcessEnv = process.env): Investigator {
  const choice = env.INVESTIGATOR_PROVIDER ?? "auto";
  if (choice === "rules" || (choice === "auto" && !env.ANTHROPIC_API_KEY)) return rulesInvestigator;
  return createClaudeInvestigator({ model: env.INVESTIGATOR_MODEL || undefined });
}
