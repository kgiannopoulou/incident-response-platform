import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  AI_POSTMORTEM_SYSTEM_PROMPT,
  aiPostmortemOutputSchema,
  buildAiUserPrompt,
  ruleBasedPostmortemDraft,
  type AiPostmortemContext,
  type AiPostmortemOutput,
} from "@irp/shared";

// Turns an incident's context into a postmortem draft. Two implementations:
//
//   claude — the Claude API with structured outputs: the response must match
//            aiPostmortemOutputSchema, or it is rejected
//   rules  — a deterministic, offline draft (no API key needed); labelled
//            as "rules" in the UI, never as AI
//
// Tests inject their own drafter.
export type DraftResult = {
  output: AiPostmortemOutput;
  model: string | null;
  usage?: Record<string, number | null>;
};

export type PostmortemDrafter = {
  provider: "claude" | "rules";
  model: string | null;
  draft(context: AiPostmortemContext): Promise<DraftResult>;
};

// A failure that retrying can't fix (bad key, refused, unparseable output):
// the job fails at once instead of burning its retries.
export class PermanentDraftError extends Error {}

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

export function createClaudeDrafter(options: { apiKey?: string; model?: string; client?: Anthropic } = {}): PostmortemDrafter {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 120_000, maxRetries: 2 });
  const model = options.model ?? DEFAULT_AI_MODEL;
  return {
    provider: "claude",
    model,
    async draft(context) {
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 16000,
          // If the model declines for policy reasons, let the API retry on
          // its recommended fallback model instead of failing the draft.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: AI_POSTMORTEM_SYSTEM_PROMPT,
          output_config: { format: betaZodOutputFormat(aiPostmortemOutputSchema), effort: "medium" },
          messages: [{ role: "user", content: buildAiUserPrompt(context) }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new PermanentDraftError("The AI provider rejected the API key (check ANTHROPIC_API_KEY)");
        }
        if (err instanceof Anthropic.BadRequestError) throw new PermanentDraftError(`The AI provider rejected the request: ${err.message}`);
        // Rate limits, overload, 5xx and network errors: let BullMQ retry.
        throw err;
      }
      if (response.stop_reason === "refusal") throw new PermanentDraftError("The model declined to draft this postmortem");
      if (response.stop_reason === "max_tokens") throw new PermanentDraftError("The draft was cut off (max_tokens)");
      if (!response.parsed_output) throw new PermanentDraftError("The model's answer did not match the postmortem schema");
      return {
        output: response.parsed_output,
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? null,
        },
      };
    },
  };
}

export const rulesDrafter: PostmortemDrafter = {
  provider: "rules",
  model: null,
  async draft(context) {
    return { output: ruleBasedPostmortemDraft(context), model: null };
  },
};

// AI_POSTMORTEM_PROVIDER=claude|rules|auto (default auto: Claude when an
// ANTHROPIC_API_KEY is configured, otherwise the offline rules).
export function drafterFromEnv(env: NodeJS.ProcessEnv = process.env): PostmortemDrafter {
  const choice = env.AI_POSTMORTEM_PROVIDER ?? "auto";
  if (choice === "rules" || (choice === "auto" && !env.ANTHROPIC_API_KEY)) return rulesDrafter;
  return createClaudeDrafter({ model: env.AI_POSTMORTEM_MODEL || undefined });
}
