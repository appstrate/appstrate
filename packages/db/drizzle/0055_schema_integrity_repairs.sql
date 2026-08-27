-- Four schema defects, all found by diffing the DECLARED schema against a
-- catalog built by replaying this journal (`migration-schema-parity.test.ts`).
-- None is a query bug; each is a shape the schema claims and the database does
-- not, or a shape the schema claims and should not.
--
--   A. `audit_events.space_id` carried a real FK with `ON DELETE SET NULL`.
--   B. Three tables seq-scanned on space deletion, under a held row lock.
--   C. Two FK names exceeded Postgres' 63-byte identifier limit.
--   D. Two columns nothing read.
--
-- IT REWRITES NO ROW VALUES. Not one — `docs/NO_TRANSITIONAL_CODE.md` §2.
-- Nothing here depends on the `app_` → `spc_` id rewrite in
-- `scripts/migration/0003` having run, either: every statement below addresses
-- catalog objects (constraints, indexes, columns) and none reads, writes or
-- compares a `space_id` VALUE. A database that has run 0003 and one that has
-- not are indistinguishable to this file.
--
-- THE REVERSE COUPLING IS REAL AND IS HANDLED IN 0003. That script re-mints
-- every `app_` space id, and it derives the CHILD COLUMNS to rewrite from the
-- set of foreign keys into `spaces`. Section A takes `audit_events.space_id`
-- out of that set, so a capture-driven loop would silently stop rewriting it —
-- and with no constraint left, nothing would report the miss. 0003's step 4
-- therefore UNIONs that column in explicitly (`UNION`, not `UNION ALL`, so the
-- term dedupes on a database where this migration has not run yet). Both deploy
-- orders rewrite it exactly once. If section A is ever reverted, revisit that
-- union before assuming it became redundant.
--
-- NAME-AGNOSTIC BY CONSTRUCTION. Every constraint this file touches is found
-- through `pg_constraint` by its COLUMNS and its TARGET, never by its name.
-- That is not stylistic: production's `audit_events` predates drizzle's `_fk`
-- naming convention and carries Postgres' own `_fkey` spelling — a
-- `DROP CONSTRAINT "audit_events_org_id_organizations_id_fk"` written against
-- the declared name is exactly what failed the beta.24 deploy (42704, aborting
-- the whole batch before the next migration). Fresh installs were fine; only
-- the database with history drifted. Asking the catalog what the constraint is
-- called removes the question.
--
-- ═══ THE TWO FENCES, SET ONCE FOR THE WHOLE FILE ═══════════════════════════
--
-- Every statement below takes a lock: ACCESS EXCLUSIVE for the constraint drop,
-- the renames and the column drops, SHARE for the two index builds. So the
-- fences are set HERE, before the first of them, rather than beside the builds
-- that are merely the slowest — an unfenced `DROP CONSTRAINT` waiting behind a
-- long-lived writer is the same stalled deploy as an unfenced `CREATE INDEX`.
--
-- Both are `SET LOCAL`, both reset at the end of the file — same instrument as
-- 0039/0041/0047-0050; see 0039's header for `SET LOCAL` rather than `SET`.
-- They bound different things, which is the confusion 0047 spends six lines
-- debunking: `lock_timeout` bounds ACQUISITION (how long a statement waits for
-- its lock), `statement_timeout` bounds EXECUTION. Neither bounds the HOLD —
-- only COMMIT does, and drizzle commits the whole pending batch at once.
--
-- 60s is 0047's budget and is generous for two single-column btree builds; a
-- build that exceeds it means the table is far past any size anyone here has
-- reasoned about, and blocking the fan-out write path for the rest of the batch
-- is then not a trade to make silently. On expiry of either fence the statement
-- errors and aborts the single transaction wrapping the batch: `migrate`
-- throws, boot fails, the deploy fails its health gate. A failed deploy, not a
-- silent skip — the right trade for repairs that are not urgent.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

-- ═══ A. `audit_events.space_id` — DROP THE FOREIGN KEY ═══════════════════════
--
-- The table's own doc has always argued that `org_id` is deliberately NOT a
-- foreign key, because "an audit log is an immutable historical record: it must
-- outlive the entities it describes". Twelve lines below that argument sat
-- `space_id` with `REFERENCES spaces(id) ON DELETE SET NULL` — the same failure
-- the argument exists to prevent, on the other tenancy column.
--
-- `DELETE /api/spaces/:id` is a live route (`routes/spaces.ts` →
-- `services/spaces.ts`). Every historical audit row for that space lost its
-- attribution the moment it ran, and nothing reconstructs it: `action` is a
-- verb, `resource_id` names the resource rather than its container. The rows
-- survived as a trail nobody can scope — and deleting a space is exactly when
-- its trail matters most.
--
-- After this the column is a denormalised `text`, same posture as `org_id`.
-- The cost is stated rather than discovered: nothing stops a `space_id` naming
-- a space that no longer exists. That is the intent, not an oversight.
--
-- Dropping the FK also removes this table from section B's problem: a
-- referencing-side scan you no longer perform needs no index.
--
-- LOCK. `DROP CONSTRAINT` takes ACCESS EXCLUSIVE on `audit_events` AND on
-- `spaces` (the referenced side). Catalog-only, no table rewrite, so the work
-- is instant and the exposure is acquisition, which the fence above bounds.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.audit_events')
      AND c.contype = 'f'
      AND c.conkey = ARRAY[(
        SELECT a.attnum
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid
          AND a.attname = 'space_id'
          AND NOT a.attisdropped
      )]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE public.audit_events DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;--> statement-breakpoint

-- ═══ B. TWO SPACE-LEADING INDEXES ════════════════════════════════════════════
--
-- Deleting a space CASCADEs into `notifications` and `package_persistence`, and
-- neither had an index whose LEADING column is `space_id`. Postgres indexes
-- only the REFERENCED side of a foreign key; the referencing side is the
-- caller's job, and both callers were left to a sequential scan:
--
--   notifications        idx_notifications_unread    (org_id, space_id, …)
--                                                    WHERE read_at IS NULL
--                        idx_notifications_recipient (org_id, recipient_type,
--                                                     recipient_id, space_id)
--   package_persistence  pkp_lookup (package_id, space_id, …)
--                        pkp_org    (org_id)   pkp_run_id (run_id) WHERE …
--
-- Not one of them is usable. The cascade's only qual is `space_id`, so an
-- org-leading or package-leading index offers no seekable prefix, and the
-- planner cannot prove `idx_notifications_unread`'s `read_at IS NULL` predicate
-- from a query that does not state it — the cascade removes read rows too.
--
-- WHY IT IS WORSE THAN A SLOW QUERY. `services/spaces.ts` takes `FOR UPDATE` on
-- the organizations row (the default-space invariant), THEN issues the DELETE.
-- Both scans therefore run while that lock is held, so their duration is lock
-- hold time on the org row, not merely statement time. This is precisely the
-- class `0050` fixed for the member / end-user deletes; it did not cover the
-- space delete, and this finishes it.
--
-- SINGLE COLUMN, NOT COMPOSITE. The cascade states `space_id` and nothing else,
-- so a tail column would be maintained on every write and never narrow a seek.
-- `pkp_space` is also NON-partial, unlike its `pkp_run_id` neighbour:
-- `package_persistence.space_id` is NOT NULL, so a predicate would exclude no
-- row and only cost the planner the chance to use the index.
--
-- The third cascade target, `audit_events`, needs no index here — section A
-- removed the scan instead of indexing it.
--
-- LOCK AND COST. Plain `CREATE INDEX` (never CONCURRENTLY — Postgres forbids it
-- inside a transaction block and drizzle wraps the whole pending batch in one;
-- see 0041's header) takes SHARE. SHARE does not conflict with ACCESS SHARE, so
-- readers are unaffected both ways; it DOES conflict with ROW EXCLUSIVE, so
-- these block the notification fan-out and the agent-persistence write paths.
-- Locks are held to COMMIT and drizzle commits the batch as a whole, so that
-- block lasts the rest of the batch, not just the two builds.
--
-- Both are covered by the fences set at the top of this file.
--
-- `IF NOT EXISTS` so a partially-applied environment converges: an index that
-- is already present IS the intended end state (0041's reasoning).
CREATE INDEX IF NOT EXISTS "idx_notifications_space" ON "notifications" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pkp_space" ON "package_persistence" USING btree ("space_id");--> statement-breakpoint

-- ═══ C. TWO CONSTRAINT NAMES PAST THE 63-BYTE IDENTIFIER LIMIT ═══════════════
--
-- Drizzle derives an unnamed foreign key's name as
-- `<table>_<cols>_<refTable>_<refCols>_fk`. Two of them overflow:
--
--   integration_org_defaults_connection_id_integration_connections_id_fk   68
--   model_provider_pairings_credential_id_model_provider_credentials_id_fk 70
--
-- Postgres truncates any identifier past NAMEDATALEN-1 = 63 bytes AT CREATION,
-- silently. So the catalog has only ever held the truncated forms —
-- `…_integration_connections_` and `…_model_provider_credential` — while the TS
-- schema, every snapshot and `0000_init.sql` went on carrying the originals.
--
-- Nothing notices until something addresses the constraint BY NAME, and the
-- thing that eventually does is drizzle-kit itself: change either FK's
-- `onDelete` or its target and `generate` emits
-- `DROP CONSTRAINT "<the declared name>"`, which matches nothing, errors 42704,
-- and aborts the whole pending batch — every migration in that release, on
-- every database. Same failure as beta.24, from a different cause.
--
-- The schema now declares both explicitly (`foreignKey({ name })`), at 41 and
-- 40 bytes, and the two blocks below move the catalog to match.
--
-- ONE POPULATION, NOT TWO — and that is a finding, not an assumption. The
-- truncation is deterministic and happens at creation, so every database that
-- has ever run this DDL holds the same 63-byte string: a fresh install created
-- from the squash, and a production database that predates it and got the
-- tables from the pre-squash forward migration that generated the identical
-- name. 0053 did not touch either — its catalog sweep matched
-- `conname LIKE '%application%'` and neither name contains it.
--
-- The blocks are still written catalog-driven rather than as a literal
-- `RENAME CONSTRAINT "<truncated>" TO "<short>"`, for the beta.24 reason at the
-- top of this file: a rename keyed on a name is a rename that fails on any
-- database whose name differs, and the whole point of this section is that
-- declared names and catalog names had already diverged once here. Matching on
-- (table, column, referenced table) asks for the constraint by what it IS.
-- `conname <> <target>` makes a second run match zero rows.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.integration_org_defaults')
      AND c.confrelid = to_regclass('public.integration_connections')
      AND c.contype = 'f'
      AND c.conname <> 'integration_org_defaults_connection_id_fk'
      AND c.conkey = ARRAY[(
        SELECT a.attnum
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid
          AND a.attname = 'connection_id'
          AND NOT a.attisdropped
      )]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.integration_org_defaults RENAME CONSTRAINT %I TO %I',
      r.conname, 'integration_org_defaults_connection_id_fk'
    );
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.model_provider_pairings')
      AND c.confrelid = to_regclass('public.model_provider_credentials')
      AND c.contype = 'f'
      AND c.conname <> 'model_provider_pairings_credential_id_fk'
      AND c.conkey = ARRAY[(
        SELECT a.attnum
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid
          AND a.attname = 'credential_id'
          AND NOT a.attisdropped
      )]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.model_provider_pairings RENAME CONSTRAINT %I TO %I',
      r.conname, 'model_provider_pairings_credential_id_fk'
    );
  END LOOP;
END $$;--> statement-breakpoint

-- ═══ D. TWO COLUMNS NOTHING READS ════════════════════════════════════════════
--
-- `org_invitations.accepted_by` / `accepted_at` — written once, by
-- `markInvitationAccepted` beside the `status = 'accepted'` flip, and read by
-- nothing. `getOrgInvitations` (the only list) filters `status = 'pending'`, so
-- an accepted row never reaches the route at all; neither column appears in any
-- DTO, OpenAPI schema or SPA read. Their entire readership was two assertions
-- in `invitations.test.ts` — a test proving only that the write happened. The
-- `status` enum already records THAT an invitation was accepted; who and when
-- is in the audit log, which outlives the row (deleting an org drops every
-- invitation with it).
--
-- `chat_messages.format` / `parent_id` ARE NOT HERE, deliberately. They were
-- part of this section's finding, and `0054` — landed first, on its own —
-- already drops both. Repeating the two `DROP COLUMN IF EXISTS` here would
-- no-op rather than error, which is exactly why it must not be written: a
-- statement that cannot fail is a statement nobody can tell is redundant. One
-- owner per object; `0054` is theirs.
--
-- `IF EXISTS` on both, same convergence reasoning as the `IF NOT EXISTS`
-- above. The dependent objects go with their columns automatically and by
-- design, not by omission: dropping `accepted_by` drops
-- `idx_org_invitations_accepted_by` and the `user` foreign key that referenced
-- it, whatever those are called on a given database — which is more robust here
-- than naming them, for the beta.24 reason at the top.
--
-- LOCK. `DROP COLUMN` is catalog-only in Postgres (the column is marked dropped
-- and its storage reclaimed lazily), so there is no table rewrite. It takes
-- ACCESS EXCLUSIVE, which blocks readers too, but only for the instant it takes
-- to update the catalog; the fences at the top still cover acquisition.
ALTER TABLE "org_invitations" DROP COLUMN IF EXISTS "accepted_by";--> statement-breakpoint
ALTER TABLE "org_invitations" DROP COLUMN IF EXISTS "accepted_at";--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
