-- Phase 11: escalation policies as ordered steps.
--
--   Checkout Service — escalation policy
--
--     0 min                          → Notify Backend Team
--     5 min without acknowledgement  → Notify Team Lead
--    10 min without acknowledgement  → Notify Engineering Manager
--
-- escalation_policies 1──n escalation_steps 1──n escalation_step_targets
--
-- A step's delay_minutes is measured from when the incident *triggered*, not
-- from the previous step, so the policy reads exactly like the table above
-- and a step's deadline doesn't drift when an earlier page is sent late.
-- Delays strictly increase from step to step (validated by the API in
-- packages/shared/src/escalation.ts; the unique index rejects equal delays).
--
-- A step pages one or more targets — individual users or whole teams. The
-- API exposes a target as { "targetType": "team", "targetId": 3 }; the table
-- keeps one real foreign key per type instead of a polymorphic id, so a
-- deleted user/team can never leave a dangling target behind.

ALTER TABLE escalation_policies ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE escalation_policies ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE escalation_policies ADD CONSTRAINT escalation_policies_org_name_key UNIQUE (organization_id, name);

CREATE TABLE escalation_steps (
  id SERIAL PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
  -- 1-based; this is the incident's escalation_level once the step is paged.
  position INTEGER NOT NULL CHECK (position >= 1),
  delay_minutes INTEGER NOT NULL CHECK (delay_minutes BETWEEN 0 AND 1440),
  UNIQUE (policy_id, position),
  UNIQUE (policy_id, delay_minutes)
);

CREATE TABLE escalation_step_targets (
  id SERIAL PRIMARY KEY,
  step_id INTEGER NOT NULL REFERENCES escalation_steps(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'team')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT escalation_step_targets_shape CHECK (
    (target_type = 'user' AND user_id IS NOT NULL AND team_id IS NULL) OR
    (target_type = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE INDEX escalation_step_targets_step_idx ON escalation_step_targets (step_id);
CREATE UNIQUE INDEX escalation_step_targets_user_idx ON escalation_step_targets (step_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX escalation_step_targets_team_idx ON escalation_step_targets (step_id, team_id) WHERE team_id IS NOT NULL;

-- Carry existing policies over. Old rules stored each level's delay relative
-- to the previous level; a running sum turns that into "minutes since the
-- incident triggered".
INSERT INTO escalation_steps (policy_id, position, delay_minutes)
SELECT policy_id, level, sum(delay_minutes) OVER (PARTITION BY policy_id ORDER BY level)
FROM (
  SELECT DISTINCT ON (policy_id, level) policy_id, level, delay_minutes
  FROM escalation_rules ORDER BY policy_id, level, id
) per_level;

INSERT INTO escalation_step_targets (step_id, target_type, user_id, team_id)
SELECT DISTINCT s.id,
       CASE WHEN r.target_user_id IS NOT NULL THEN 'user' ELSE 'team' END,
       r.target_user_id, r.target_team_id
FROM escalation_rules r
JOIN escalation_steps s ON s.policy_id = r.policy_id AND s.position = r.level;

DROP TABLE escalation_rules;
