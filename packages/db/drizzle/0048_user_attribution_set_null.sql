-- Make user deletion possible: nine attribution FKs to `user` move from
-- ON DELETE NO ACTION to ON DELETE SET NULL, and each gains the
-- referencing-side index the action needs.
--
-- ═══ THE NINE, AND WHY THEY ARE THE ODD ONES OUT ═══
--
-- 33 foreign keys in this schema reference `user`. Every one of them is
-- deliberate about deletion: 15 CASCADE (the row IS the user's — sessions,
-- accounts, consents, chat sessions), 9 SET NULL (the row SURVIVES the user
-- and keeps its other meaning — `runs.user_id`, `files.user_id`,
-- `llm_usage.user_id`, `uploads.created_by`, `applications.created_by`, …),
-- and these 9, which are the same ATTRIBUTION shape as the SET NULL group
-- but carry no `onDelete` at all and therefore default to NO ACTION:
--
--   organizations.created_by              org_proxies.created_by
--   org_invitations.invited_by            api_keys.created_by
--   org_invitations.accepted_by           model_provider_credentials.created_by
--   org_models.created_by                 packages.created_by
--                                         package_versions.created_by
--
-- Every one of the nine columns is ALREADY NULLABLE, which is the tell: the
-- schema always intended these rows to outlive their author. Only the FK
-- action disagrees. `applications.created_by` and `uploads.created_by` are the
-- identical column in the identical role and both are SET NULL — this is drift,
-- not a policy.
--
-- ═══ LATENT, NOT BROKEN — AND WHY THAT IS THE ARGUMENT FOR FIXING IT NOW ═══
--
-- Nobody has hit this wall because there is no user-deletion path: Better
-- Auth's `deleteUser` is not enabled anywhere (`grep -rn deleteUser` over
-- `packages/db/src` and `apps/api/src` returns nothing), so no code ever issues
-- `DELETE FROM "user"`. The first account-deletion feature — GDPR erasure, a
-- self-serve "delete my account", an admin purge — hits all nine at once, as
-- nine separate `23503` violations, one per attempted delete, discovered at
-- runtime by whoever ships that feature. Fixing it in the schema costs a
-- catalog swap today; fixing it inside a deletion feature costs that feature a
-- migration it did not plan for.
--
-- What SET NULL means for the surviving row: attribution is lost, the row is
-- not. An org keeps existing after its founder's account is deleted; an API
-- key keeps authenticating; a package keeps its versions. That is the correct
-- reading of "who created this" — a courtesy field, never an ownership proof
-- (ownership is `org_id` + `org_members`, none of which is touched here).
--
-- `org_invitations` gets both of its user columns. `invited_by` is the same
-- attribution shape; `accepted_by` is an audit stamp on a consumed invitation
-- and equally non-load-bearing.
--
-- ═══ WHY EACH DROP GOES THROUGH THE CATALOG, NOT A LITERAL NAME ═══
--
-- Postgres cannot change a foreign key's action in place — the constraint must
-- be dropped and re-added. Dropping it by the name the SNAPSHOT declares
-- (`organizations_created_by_user_id_fk`, drizzle's convention) would be a
-- guess on production: constraints created by raw SQL rather than by drizzle
-- get Postgres's own default suffix `_fkey`, and this schema has already been
-- caught with that drift (`audit_events`). A wrong name means
-- `constraint … does not exist`, which aborts the single transaction wrapping
-- the whole pending batch and wedges the deploy.
--
-- So each block looks the constraint up by IDENTITY instead of by name —
-- (referencing table, exactly this one column, referenced table `user`) — and
-- drops whatever it finds, under whatever name. `IF existing IS NOT NULL` makes
-- a re-run and a partially-applied environment converge. The ADD then always
-- uses the canonical drizzle name, so after this migration the catalog and the
-- snapshot agree no matter which name they started from.
--
-- The ADD is deliberately NOT guarded by an existence check: if the lookup
-- above found nothing AND a constraint by the canonical name already exists,
-- the ADD fails loudly. That is the case where reality disagrees with both
-- theories of the name and the deploy should stop, not paper over it.
--
-- ═══ THE NINE INDEXES — SPECULATIVE CAPACITY, KEPT ON PURPOSE ═══
--
-- Postgres indexes the REFERENCED side of a foreign key, never the referencing
-- one (`src/schema/files.ts:124-131` documents this convention and 0029 applied
-- it to `uploads` / `documents`). Without them, SET NULL turns one user
-- deletion into nine sequential scans — over `packages`, `package_versions`,
-- `api_keys`, … — each under the lock the deletion holds.
--
-- The uncomfortable half of that, stated rather than left implied: NOTHING
-- TRIGGERS THAT SCAN TODAY. The section above establishes there is no
-- user-deletion path at all, so the nine indexes serve a scan that never runs,
-- while every INSERT into `packages`, `package_versions`, `api_keys`,
-- `organizations`, `org_invitations` (twice), `org_models`, `org_proxies` and
-- `model_provider_credentials` pays their maintenance from the moment this
-- migration commits. This is capacity bought ahead of its reader.
--
-- 0039 refused a neighbouring trade three days and nine migrations earlier
-- (2026-08-21 against 2026-08-24, per `meta/_journal.json`), on five of these
-- same tables: it dropped `idx_packages_org_id`,
-- `idx_package_versions_package_id`, `idx_model_provider_credentials_org_id`
-- and `idx_org_invitations_token` as leading-prefix duplicates, and
-- `idx_api_keys_key_prefix` as read by nothing — in each case because a write
-- path should not pay for an index no read uses.
--
-- The departure is deliberate, and the distinction is narrow but real. 0039's
-- eighteen had readers that COULD NOT EXIST: a narrow index under a wider
-- non-partial one is redundant by construction, and a column no query filters
-- on stays unfiltered whatever ships next. These nine have a reader that is
-- defined but unreachable — the SET NULL action installed above is in the
-- catalog, and it will scan exactly these columns the first time anything
-- deletes a user. 0039's indexes would still have been dead after any feature;
-- these stop being dead the day one arrives.
--
-- WHY NOT DEFER THEM TO THAT FEATURE. Because dropping the nine `CREATE INDEX`
-- statements would not defer the cost, it would only hide it: all nine are
-- DECLARED in the TypeScript schema — `src/schema/organizations.ts:72,119,120,
-- 156,183,285,426` and `src/schema/packages.ts:104,143` — and therefore sit in
-- `meta/0048_snapshot.json`. A migration without them leaves the catalog and
-- the snapshot disagreeing, and the next `db:generate` re-emits these exact
-- nine statements as a diff nobody authored. Deferring them honestly means
-- deleting the declarations too, which is a schema-shape change this pass does
-- not make. So: kept, cost written down rather than assumed away, and cheap to
-- reverse the day someone measures the write path and disagrees — nine
-- `DROP INDEX` and nine deleted lines, the shape 0039 already has.
--
-- NON-PARTIAL, unlike `idx_files_end_user` and 0029's `uploads` indexes. Those
-- are partial (`WHERE col IS NOT NULL`) because their NULL population dominates
-- and would otherwise bloat the index. Here the population is inverted —
-- nearly every organization, package and key has a recorded author — so the
-- predicate would exclude almost nothing while adding a proof obligation for
-- the planner. Same convention, opposite data, opposite answer.
--
-- ═══ LOCK AND COST ═══
--
-- `ALTER TABLE … DROP CONSTRAINT` / `ADD CONSTRAINT … FOREIGN KEY` takes ACCESS
-- EXCLUSIVE on the referencing table AND (for the ADD) a SHARE ROW EXCLUSIVE on
-- `user`. ACCESS EXCLUSIVE conflicts with every lock mode including readers,
-- and the request queues ahead of everything behind it. `packages`,
-- `package_versions` and `api_keys` are on read paths that run constantly.
--
-- The ADD also forces a validation scan of the referencing table. Nothing here
-- is added `NOT VALID`: splitting `ADD … NOT VALID` from a later
-- `VALIDATE CONSTRAINT` relieves lock pressure only when the halves land in
-- DIFFERENT deploys, and the boot migrator applies every pending migration in
-- ONE transaction — the ACCESS EXCLUSIVE is held to that transaction's commit
-- either way (0029's header makes the same argument).
--
-- THAT SCAN CAN FAIL, and this file's own `IF existing IS NOT NULL` is the
-- admission of it. Where the constraint is present the scan re-validates rows
-- an existing constraint already accepted and cannot find a violation. Where it
-- is ABSENT — the only reason that guard is conditional rather than
-- unconditional — the ADD performs a first-ever validation, and a single
-- `created_by` pointing at a row no longer in `user` raises `23503` and aborts
-- the whole batch. The shape is not hypothetical: production is documented as
-- missing 2 of the 132 indexes the squash introduced (0039 and 0041), because
-- anything a squash introduces without a matching forward migration never
-- reaches a database that predates it — and nobody has run the equivalent audit
-- for squash-introduced CONSTRAINTS. Failing is the right behaviour; finding
-- out during the deploy is not. Run this against the target first:
--
--   DO $$
--   DECLARE
--     pairs text[][] := ARRAY[
--       ['organizations','created_by'], ['org_invitations','invited_by'],
--       ['org_invitations','accepted_by'], ['org_models','created_by'],
--       ['org_proxies','created_by'], ['api_keys','created_by'],
--       ['model_provider_credentials','created_by'], ['packages','created_by'],
--       ['package_versions','created_by']];
--     orphans bigint;
--   BEGIN
--     FOR i IN 1..array_length(pairs, 1) LOOP
--       EXECUTE format(
--         'SELECT count(*) FROM public.%I t WHERE t.%I IS NOT NULL'
--         ' AND NOT EXISTS (SELECT 1 FROM public."user" u WHERE u.id = t.%I)',
--         pairs[i][1], pairs[i][2], pairs[i][2]) INTO orphans;
--       RAISE NOTICE '%.% -> % orphan(s)', pairs[i][1], pairs[i][2], orphans;
--     END LOOP;
--   END $$;
--
-- Every count must be 0. A non-zero one means that FK was never on this
-- database, and the orphan rows have to be nulled out before the ADD below can
-- validate.
--
-- The `CREATE INDEX` statements take SHARE — they block writers, not readers —
-- and cannot use CONCURRENTLY, which Postgres forbids inside a transaction
-- block (see 0041's header).
--
-- Hence the `SET LOCAL lock_timeout = '3s'` fence, reset to DEFAULT after —
-- same instrument as 0039/0041/0047; see 0039's header for `SET LOCAL` rather
-- than `SET` and for why the reset matters. The cost on expiry: the statement
-- errors and aborts the single transaction wrapping the batch — `migrate`
-- throws, boot fails, the deploy fails its health gate. That is the right trade
-- for a latent fix nobody is waiting on (fail fast, retry), but it is a failed
-- deploy, not a silent skip. The 3s budget is per STATEMENT: 18 statements each
-- wait up to 3s.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.organizations'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.organizations DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.org_invitations'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'invited_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.org_invitations DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.org_invitations'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'accepted_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.org_invitations DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.org_models'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.org_models DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "org_models" ADD CONSTRAINT "org_models_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.org_proxies'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.org_proxies DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "org_proxies" ADD CONSTRAINT "org_proxies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.api_keys'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.api_keys DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.model_provider_credentials'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.model_provider_credentials DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.packages'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.packages DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "packages" ADD CONSTRAINT "packages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
DO $$
DECLARE
  existing text;
BEGIN
  SELECT con.conname INTO existing
  FROM pg_constraint con
  WHERE con.conrelid = 'public.package_versions'::regclass
    AND con.contype = 'f'
    AND con.confrelid = 'public."user"'::regclass
    AND con.conkey = ARRAY[(
      SELECT att.attnum FROM pg_attribute att
      WHERE att.attrelid = con.conrelid AND att.attname = 'created_by'
    )]::smallint[];
  IF existing IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.package_versions DROP CONSTRAINT %I', existing);
  END IF;
  ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_organizations_created_by" ON "organizations" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_invitations_invited_by" ON "org_invitations" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_invitations_accepted_by" ON "org_invitations" USING btree ("accepted_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_models_created_by" ON "org_models" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_proxies_created_by" ON "org_proxies" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_created_by" ON "api_keys" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_model_provider_credentials_created_by" ON "model_provider_credentials" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_packages_created_by" ON "packages" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_package_versions_created_by" ON "package_versions" USING btree ("created_by");
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;