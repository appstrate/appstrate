-- 0011_persistence_unify.sql
--
-- Drop the `kind` enum on `package_persistence` in favour of two
-- orthogonal dimensions: `key` (nullable; sets cardinality — null = append,
-- present = upsert-by-key) and `pinned` (boolean; sets prompt visibility —
-- pinned rows are injected, archive rows are tool-retrievable only).
--
-- Mapping: `kind = 'checkpoint'` → `key = 'checkpoint'`, `pinned = true`.
--          `kind = 'memory'`     → `key = NULL`,         `pinned = false`.
--
-- See docs/adr/ADR-012-memory-as-tool.md.

ALTER TABLE "package_persistence"
  ADD COLUMN "key"    text,
  ADD COLUMN "pinned" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Translate existing rows. Idempotent under re-run: a second pass leaves
-- already-translated rows untouched because `kind` no longer exists at
-- that point.
UPDATE "package_persistence"
   SET "key" = 'checkpoint', "pinned" = true
 WHERE "kind" = 'checkpoint';
--> statement-breakpoint

-- Memories already default to (key = NULL, pinned = false) via the column
-- defaults, so no UPDATE needed for `kind = 'memory'` rows.

-- Drop the kind-aware indexes and constraint before dropping the column.
DROP INDEX IF EXISTS "pkp_checkpoint_unique";
--> statement-breakpoint

DROP INDEX IF EXISTS "pkp_lookup";
--> statement-breakpoint

ALTER TABLE "package_persistence"
  DROP CONSTRAINT IF EXISTS "pkp_kind_valid";
--> statement-breakpoint

ALTER TABLE "package_persistence"
  DROP COLUMN "kind";
--> statement-breakpoint

-- Upsert target for named slots (today: only `checkpoint`). The partial
-- WHERE keeps the index out of the way for archive rows (`key IS NULL`).
-- COALESCE on actor_id matches the prior pkp_checkpoint_unique behaviour
-- so the shared bucket compares-equal to itself across PG and PGlite.
CREATE UNIQUE INDEX IF NOT EXISTS "pkp_key_unique"
  ON "package_persistence" ("package_id", "application_id", "actor_type", (COALESCE("actor_id", '__shared__')), "key")
  WHERE "key" IS NOT NULL;
--> statement-breakpoint

-- Primary read paths: getCheckpoint (key='checkpoint'), listMemories
-- (key IS NULL), listPinnedMemories (pinned + key IS NULL),
-- recall_memory (pinned=false + ILIKE).
CREATE INDEX IF NOT EXISTS "pkp_lookup"
  ON "package_persistence" ("package_id", "application_id", "actor_type", "actor_id", "key", "pinned");
