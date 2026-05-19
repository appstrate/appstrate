-- Extend integration_pins with member-pin scope.
--
-- Before: PK (application_id, package_id, integration_package_id, auth_key) — one
-- pin per agent×integration×auth, admin-only.
--
-- After: nullable user_id column discriminates scope.
--   user_id IS NULL  → admin force pin (existing rows fall into this bucket)
--   user_id NOT NULL → member preference pin (new, replaces R5 localStorage)
--
-- Resolver cascade gains a layer 4 "member pin matching actor":
--   1. admin pin               (user_id IS NULL)
--   2. run override
--   3. schedule override
--   4. member pin              (user_id = actor.id)
--   5. fallback
--
-- One table, one connectionId FK cascade, one reverse-lookup index — the
-- impact-list query on /connections destructive delete reads all impacted
-- pins in a single hit.

-- 1. Add surrogate id (existing composite PK becomes too narrow to express the
--    user_id discriminator without losing uniqueness; switch to UUID PK and
--    enforce the conceptual key via a UNIQUE INDEX that includes user_id).
ALTER TABLE "integration_pins"
    ADD COLUMN IF NOT EXISTS "id" uuid NOT NULL DEFAULT gen_random_uuid();

-- 2. Drop the old composite PK before adding the new column to the key.
ALTER TABLE "integration_pins"
    DROP CONSTRAINT IF EXISTS "integration_pins_pkey";

ALTER TABLE "integration_pins"
    ADD CONSTRAINT "integration_pins_pkey" PRIMARY KEY ("id");

-- 3. Member-pin scope column. NULL = admin force (existing rows), NOT NULL =
--    this member's personal preference.
ALTER TABLE "integration_pins"
    ADD COLUMN IF NOT EXISTS "user_id" text;

DO $$ BEGIN
    ALTER TABLE "integration_pins"
        ADD CONSTRAINT "integration_pins_user_id_user_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 4. New conceptual uniqueness: (app, agent, integration, authKey, scope).
--    coalesce(user_id, '') keeps the constraint usable across both scopes —
--    PostgreSQL treats NULL as distinct in UNIQUE by default, which would
--    let two admin pins coexist on the same key (semantic bug).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_integration_pins_unique"
    ON "integration_pins" (
        "application_id", "package_id", "integration_package_id",
        "auth_key", (coalesce("user_id", ''))
    );

-- 5. Member-pin partial index — keeps the index small (most rows are admin
--    pins with user_id IS NULL) while making member-scope lookups fast.
CREATE INDEX IF NOT EXISTS "idx_integration_pins_user"
    ON "integration_pins" ("user_id")
    WHERE "user_id" IS NOT NULL;
