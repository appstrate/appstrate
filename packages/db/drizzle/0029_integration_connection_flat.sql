-- Flatten the integration connection selection model from
-- (integration, authKey) → connection to integration → connection.
--
-- An OAuth connection and an API-key connection are both just
-- "connections" — the choice between them was making the resolver
-- ignore pins on non-required auths (every tool declared
-- `requiredAuthKey: oauth`, so a pin on `pat` was loaded but never
-- consulted). The agent's `requiredAuthKey` survives as input to
-- OAuth-consent scope inference but is no longer a runtime selector.

-- ── integration_pins ──
-- Drop auth_key from the uniqueness key + remove the column.
DROP INDEX IF EXISTS "idx_integration_pins_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_pins_unique" ON "integration_pins" (
    "application_id",
    "package_id",
    "integration_package_id",
    (coalesce("user_id", ''))
);

-- If multiple pins existed for the same (app, agent, integration, scope)
-- across different auth keys, keep the most-recently-updated one.
DELETE FROM "integration_pins" a
USING "integration_pins" b
WHERE a.application_id = b.application_id
  AND a.package_id = b.package_id
  AND a.integration_package_id = b.integration_package_id
  AND coalesce(a.user_id, '') = coalesce(b.user_id, '')
  AND a.updated_at < b.updated_at;

ALTER TABLE "integration_pins" DROP COLUMN IF EXISTS "auth_key";

-- ── runs.connection_overrides / runs.resolved_connections ──
-- Old shape: {integration: {authKey: <id-or-resolved>}}.
-- New shape: {integration: <id-or-resolved>}.
-- Project by taking the FIRST value of each inner object.
UPDATE "runs"
   SET connection_overrides = (
         SELECT jsonb_object_agg(int_key, inner_first.val)
           FROM jsonb_each(connection_overrides) AS outer_(int_key, inner_obj)
           CROSS JOIN LATERAL (
             SELECT value AS val
               FROM jsonb_each(inner_obj)
              LIMIT 1
           ) AS inner_first
       )
 WHERE connection_overrides IS NOT NULL
   AND jsonb_typeof(connection_overrides) = 'object';

UPDATE "runs"
   SET resolved_connections = (
         SELECT jsonb_object_agg(int_key, inner_first.val)
           FROM jsonb_each(resolved_connections) AS outer_(int_key, inner_obj)
           CROSS JOIN LATERAL (
             SELECT value AS val
               FROM jsonb_each(inner_obj)
              LIMIT 1
           ) AS inner_first
       )
 WHERE resolved_connections IS NOT NULL
   AND jsonb_typeof(resolved_connections) = 'object';

-- ── package_schedules.connection_overrides ──
UPDATE "package_schedules"
   SET connection_overrides = (
         SELECT jsonb_object_agg(int_key, inner_first.val)
           FROM jsonb_each(connection_overrides) AS outer_(int_key, inner_obj)
           CROSS JOIN LATERAL (
             SELECT value AS val
               FROM jsonb_each(inner_obj)
              LIMIT 1
           ) AS inner_first
       )
 WHERE connection_overrides IS NOT NULL
   AND jsonb_typeof(connection_overrides) = 'object';
