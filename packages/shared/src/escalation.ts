import { z } from "zod";

// Escalation policies: who gets paged, and when, while nobody acknowledges.
//
//   0 min                          → Notify Backend Team
//   5 min without acknowledgement  → Notify Team Lead
//  10 min without acknowledgement  → Notify Engineering Manager
//
// Each step's delay is minutes since the incident *triggered* (not since
// the previous step), so a policy reads top to bottom like the list above.
// Pure code shared by the API (validation, manual escalation), the worker
// (automatic escalation) and the web editor.

export const ESCALATION_TARGET_TYPES = ["user", "team"] as const;
export type EscalationTargetType = (typeof ESCALATION_TARGET_TYPES)[number];

export const MAX_ESCALATION_STEPS = 10;
export const MAX_ESCALATION_DELAY_MINUTES = 24 * 60;

export const escalationTargetSchema = z.object({
  targetType: z.enum(ESCALATION_TARGET_TYPES),
  targetId: z.number().int().positive(),
});
export type EscalationTarget = z.infer<typeof escalationTargetSchema>;

export const escalationStepSchema = z.object({
  delayMinutes: z.number().int().min(0).max(MAX_ESCALATION_DELAY_MINUTES),
  targets: z.array(escalationTargetSchema).min(1, "every step needs at least one target").max(10),
});
export type EscalationStepInput = z.infer<typeof escalationStepSchema>;

export const escalationPolicySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).default(""),
    steps: z.array(escalationStepSchema).min(1, "a policy needs at least one step").max(MAX_ESCALATION_STEPS),
  })
  .superRefine((policy, ctx) => {
    policy.steps.forEach((step, i) => {
      const previous = policy.steps[i - 1];
      if (previous && step.delayMinutes <= previous.delayMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "delayMinutes"],
          message: `step ${i + 1} must come later than step ${i} (${previous.delayMinutes} min)`,
        });
      }
      const seen = new Set<string>();
      step.targets.forEach((target, j) => {
        const key = `${target.targetType}:${target.targetId}`;
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["steps", i, "targets", j], message: "duplicate target in this step" });
        }
        seen.add(key);
      });
    });
  });
export type EscalationPolicyInput = z.infer<typeof escalationPolicySchema>;

// The minimum a scheduler needs to know about a step.
export type EscalationStepTiming = { position: number; delayMinutes: number };

// The first step after `currentLevel` (0 = nothing paged yet), or null when
// the policy is exhausted. Positions are 1-based and contiguous.
export function nextEscalationStep<T extends EscalationStepTiming>(steps: readonly T[], currentLevel: number): T | null {
  return [...steps].sort((a, b) => a.position - b.position).find((s) => s.position > currentLevel) ?? null;
}

// When a step is due. The schedule is anchored to the incident's trigger
// time; a step whose time has already passed (the worker was down, or a
// responder escalated by hand past it) is due now rather than in the past.
export function escalationDueAt(triggeredAt: Date, step: EscalationStepTiming, now = new Date()) {
  const due = new Date(triggeredAt.getTime() + step.delayMinutes * 60_000);
  return due < now ? now : due;
}

// "Immediately", "5 min without acknowledgement", "1 h 30 min without acknowledgement".
export function describeEscalationDelay(delayMinutes: number) {
  if (delayMinutes === 0) return "Immediately";
  const h = Math.floor(delayMinutes / 60);
  const m = delayMinutes % 60;
  const span = [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
  return `${span} without acknowledgement`;
}
