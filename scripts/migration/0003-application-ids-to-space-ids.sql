-- 0003 — the DATA half of the `application` → `space` rename: re-mint every
-- `app_` space id as `spc_`, and rewrite every other stored VALUE that still
-- spells the retired concept.
--
-- NOT YET REHEARSED, NOT YET APPLIED. Row counts below are placeholders — the
-- README's step 4 (`pg_dump` production → throwaway `postgres:16-alpine` →
-- apply → verify) has not been run. Fill them in from the rehearsal, then
-- again from the production run, and only then update the `## Log` row.
--
-- Why this is here and not in `packages/db/drizzle/`: it rewrites row CONTENTS,
-- not schema shape. `docs/NO_TRANSITIONAL_CODE.md` §2, and `0046`'s header,
-- which exists only because the data half of the LAST rename (#1177) was put
-- into drizzle migrations and then deleted.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THIS SCRIPT IS ONE HALF OF A DEPLOY, NOT A DEPLOY.                        │
-- │ `packages/db/drizzle/0053_applications_to_spaces.sql` renames the CATALOG │
-- │ — tables, columns, constraints, indexes, notify functions — and rewrites  │
-- │ no row. Read its header first. It must land BEFORE this script (this      │
-- │ script names `spaces` / `space_id`, which do not exist until it has), and │
-- │ this script must run in the SAME window, or the platform boots reading    │
-- │ `app_` ids through `assertSpaceId` (`apps/api/src/lib/ids.ts`), which     │
-- │ rejects them by design and says so in the 400.                            │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ═══ WHAT THIS REWRITES, AND WHAT EACH REWRITE IS ANCHORED ON ═══
--
--   1. `spaces.id` and the eighteen columns that reference it
--      `'spc_' || substring(… FROM 5)`, anchored `LIKE 'app\_%'`.
--      The underscore is ESCAPED — a bare `LIKE 'app_%'` treats `_` as the
--      single-character wildcard and matches `appXanything`.
--   2. persisted permission scope strings — `applications:*` → `spaces:*`
--      anchored on a whole array ELEMENT / whole whitespace-delimited TOKEN
--      starting with `applications:`.
--   3. `user.realm` and `session.realm` — anchored `LIKE 'end\_user:app\_%'`.
--   4. `files.storage_key`, `uploads.storage_key` — anchored on the SEGMENT
--      the space id occupies, by position, via a regex pinned to `^`.
--      `storage_deletion_jobs.storage_key` — anchored on segment 1 AND on
--      `bucket IN ('files','uploads')`.
--   5. `storage_deletion_jobs.reason` — `'application_deleted'` → `'space_deleted'`,
--      EXACT equality, never a substring rewrite.
--   6. `webhooks.level`, `oauth_clients.level` — `'application'` → `'space'`,
--      exact equality, plus the three `VALIDATE CONSTRAINT` promotions `0053`
--      deferred to this script.
--
-- ═══ WHAT THIS DELIBERATELY DOES NOT REWRITE ═══
--
-- `audit_events.action` (`application.created` | `.updated` | `.deleted`) and
-- `audit_events.resource_type` (`'application'`). Also `audit_events.before` /
-- `.after`, the jsonb snapshots of what a row LOOKED LIKE at the time.
--
-- `audit_events` is an APPEND-ONLY RECORD OF WHAT HAPPENED. Rewriting it
-- falsifies the history it exists to keep — `0046`'s header states the rule and
-- `0044` applied it to the same table. New writes use the new vocabulary, so an
-- operator's `GROUP BY action` is permanently split across two spellings, one
-- per era. THAT SPLIT IS THE CORRECT OUTCOME. Do not "finish the job" here.
--
-- `audit_events.space_id` IS rewritten, and the asymmetry is deliberate rather
-- than an oversight: it is a live FOREIGN KEY into `spaces`, not a record of
-- the past. Leaving it behind does not preserve history, it breaks the
-- reference — and the FK re-add in step 4 would refuse to validate.
--
-- Also untouched, for the record:
--   * `runs.input`, `runs.result`, `run_logs`, `chat_messages.content` — a
--     space id can appear quoted inside these payloads, but NOTHING parses one
--     back out of them. The only two parse-back paths in the codebase are the
--     `X-Space-Id` header (`middleware/space-context.ts`) and the `space_id`
--     columns rewritten below; verified by grepping every `assertSpaceId` /
--     `SPACE_ID_RE` call site. They are display/audit text, same class as
--     `run_logs`' prose in `0001`.
--   * the idempotency cache (`idem:{orgId}:{spaceId}:{key}`,
--     `apps/api/src/lib/idempotency.ts`) and the OIDC social-provider cache key
--     (`{spaceId}:{provider}`) — Redis / in-memory, 24h TTL, not SQL. A stale
--     entry MISSES; it never mis-resolves.
--   * `space_social_providers.scopes`, `integration_connections.scopes_granted`
--     and `account.scope` — THIRD-PARTY provider scopes (Google, GitHub, …),
--     not Appstrate permissions. `0046` names them for the same reason.
--
-- ═══ WHY `LIKE 'app\_%'` AND NOT `0001`'s STRICT-UUID MATCH ═══
--
-- `0001` matched `doc_` + a canonical UUID so that chat rows merely DISCUSSING
-- the id format were not rewritten. The opposite rule applies here. This id is
-- the target of eighteen foreign keys: parent and child must be transformed by
-- the SAME function or the reference breaks. A strict-UUID filter would skip a
-- non-canonical `app_` id (a fixture, a hand-inserted row) on BOTH sides —
-- consistently, so the FK survives — but would leave a space that
-- `assertSpaceId` then rejects on every request, silently un-migrated.
--
-- So the match is deliberately loose, and the CANONICAL-SHAPE check is moved
-- into the verification instead (query D below), where a non-canonical
-- survivor is REPORTED rather than skipped.
--
-- ═══ ORDER IS LOAD-BEARING: THE `level` REWRITE COMES FIRST ═══
--
-- `0053` re-added three CHECK constraints `NOT VALID`:
--
--   webhooks_level_values      CHECK (level IN ('org','space'))
--   webhooks_level_check       CHECK ((level='org' AND space_id IS NULL)
--                                  OR (level='space' AND space_id IS NOT NULL))
--   oauth_clients_level_check  CHECK (… level='space' …)
--
-- `NOT VALID` skips only the initial full-table scan. The constraint is
-- enforced on EVERY subsequent INSERT AND UPDATE — including an UPDATE to a row
-- that was already violating it. A row still holding `level = 'application'`
-- therefore cannot have its `space_id` / `referenced_space_id` rewritten: the
-- id UPDATE re-checks the whole row and raises `check_violation`.
--
-- Rewriting `level` first fixes that in the only order that works. Row (level
-- `'application'`, space_id `'app_…'`) → set level `'space'`: arm 2 of the
-- CHECK now matches (space_id IS NOT NULL), so the level UPDATE itself passes;
-- the id UPDATE that follows then re-checks a row that already satisfies the
-- constraint. Reverse the two steps and the script dies on the first webhook.
--
-- ═══ TWO TRIGGERS MUST BE DISABLED, EACH FOR ITS OWN REASON ═══
--
-- `oauth_clients_level_immutable` (a BEFORE UPDATE FOR EACH ROW trigger from
-- `0003_fold_oidc_tables.sql`, not expressible in Drizzle so it is invisible in
-- `schema/oidc.ts`) RAISES on any change to `oauth_clients.level`. It is the
-- guard that stops a client silently changing audience; it is also an absolute
-- bar on the one legitimate change this script exists to make. Disabled around
-- that single UPDATE and re-enabled immediately, inside the transaction.
--
-- `runs_notify_update_trigger` and `integration_connections_notify_trigger`
-- (`packages/db/src/notify.ts`) `pg_notify` on every row whose `space_id`
-- changes — which is every row this script touches. Left enabled, a rewrite of
-- a production `runs` table queues one notification PER HISTORICAL RUN, all
-- delivered at COMMIT, and every connected SSE subscriber is told that every
-- run it has ever seen just changed. Disabled around the id rewrite and
-- re-enabled before COMMIT. Nothing depends on those events firing: the values
-- they carry are the ones this script is rewriting.
--
-- All four ENABLE statements are inside the single transaction, so a failure
-- anywhere rolls back to a database with its triggers intact.
--
-- ═══ THE EIGHTEEN FOREIGN KEYS ═══
--
-- None carries `ON UPDATE CASCADE` and none is DEFERRABLE, so the parent id
-- cannot move under them: they must be dropped, the values rewritten, and the
-- constraints restored — the shape `0001` used for two keys, at scale.
--
-- The drop/restore is CATALOG-DRIVEN. It captures `pg_get_constraintdef()` for
-- every FK whose `confrelid` is `spaces` into a temp table and replays those
-- definitions verbatim. That is not laziness about writing eighteen lines: it
-- is the only form that CANNOT get an `ON DELETE` wrong, cannot miss a
-- nineteenth key added after this file was written, and cannot invent a name
-- for a constraint whose name drifted (`_fkey` vs `_fk` — see `0053` TRAP 1,
-- and `cli_refresh_tokens_parent_id_fkey`, the surviving example in this
-- schema). Step 4's closing assertion re-counts them and RAISES if one did not
-- come back.
--
-- What the catalog held when this was written — the list is documentation, not
-- an input to the SQL. SEVENTEEN ARE `ON DELETE CASCADE`; `audit_events` IS THE
-- ONE EXCEPTION AND IS `ON DELETE SET NULL`. Getting that one wrong would
-- silently convert "keep the audit row, forget the space" into "delete the
-- audit trail with the space", and nothing would ever report it.
--
--   api_keys.space_id                      → spaces.id   ON DELETE CASCADE
--   audit_events.space_id                  → spaces.id   ON DELETE SET NULL  ←
--   end_users.space_id                     → spaces.id   ON DELETE CASCADE
--   files.space_id                         → spaces.id   ON DELETE CASCADE
--   integration_connections.space_id       → spaces.id   ON DELETE CASCADE
--   integration_oauth_clients.space_id     → spaces.id   ON DELETE CASCADE
--   integration_org_defaults.space_id      → spaces.id   ON DELETE CASCADE
--   integration_pins.space_id              → spaces.id   ON DELETE CASCADE
--   notifications.space_id                 → spaces.id   ON DELETE CASCADE
--   oauth_clients.referenced_space_id      → spaces.id   ON DELETE CASCADE
--   package_persistence.space_id           → spaces.id   ON DELETE CASCADE
--   package_schedules.space_id             → spaces.id   ON DELETE CASCADE
--   runs.space_id                          → spaces.id   ON DELETE CASCADE
--   space_packages.space_id                → spaces.id   ON DELETE CASCADE
--   space_smtp_configs.space_id            → spaces.id   ON DELETE CASCADE
--   space_social_providers.space_id        → spaces.id   ON DELETE CASCADE
--   uploads.space_id                       → spaces.id   ON DELETE CASCADE
--   webhooks.space_id                      → spaces.id   ON DELETE CASCADE
--
-- ═══ ANCHORED, NEVER A BARE replace() — AND ANCHORED ON THE LEGACY SPELLING ═══
--
-- `0046`'s hazard note applies verbatim, with a live example on the other side.
-- Anchor on `applications:`, NEVER on `spaces:`. Third-party integration
-- manifests declare their own scope vocabulary and are persisted in
-- `packages.draft_manifest` and `package_versions.manifest` — the Monday and
-- Typeform integrations ship `workspaces:read` / `workspaces:write` in their
-- `scope_catalog` (`scripts/system-packages/integration-monday-1.0.2/manifest.json`).
-- Any pass that matched on `spaces:` as a suffix or substring would rewrite
-- those. Symmetrically, a bare `replace('applications:', 'spaces:')` would turn
-- `myapplications:read` into `myspaces:read`. Both directions are guarded by
-- requiring the whole element / whole token to START with `applications:`.
--
-- Why this matters more than it looks: `resolveApiKeyPermissions`
-- (`apps/api/src/lib/permissions.ts`) intersects a key's stored scope set with
-- its creator's role permissions and DROPS every string it does not recognise.
-- A key issued as `applications:write` keeps authenticating and simply grants
-- less than it was issued with — no error, no rejection, no user-visible
-- signal. `narrowScopeToClient` and `scopesToPermissions` do the same for CLI
-- refresh rotation and live bearer tokens.
--
-- ═══ IDEMPOTENCY ═══
--
-- Every `WHERE` is exactly the condition its `UPDATE` removes, so a second run
-- matches zero rows and a partially applied environment converges. The
-- FK drop/restore cycle is a no-op on a replay (capture 18, drop 18, update
-- nothing, restore 18). The trigger disable/enable pairs are symmetric. The
-- three `VALIDATE CONSTRAINT` statements are no-ops on an already-valid
-- constraint and are guarded on existence.
--
-- ═══ ROLLBACK ═══
--
-- Reverse each step with the mirrored anchor, in reverse order (level LAST,
-- because the CHECK ordering argument above runs backwards too), BEFORE
-- reversing `0053` — these statements name `spaces`, which `0053`'s reverse
-- renames away. A database snapshot taken before the deploy remains the fast
-- path, and is the only thing that restores the three constraints' validity
-- without a full re-scan.
--
--   -- ids: 'app_' || substring(… FROM 5) WHERE … LIKE 'spc\_%'  (same
--   --      drop/restore of the eighteen FKs)
--   -- scopes: 'applications:' || substring(s FROM 8) WHERE s LIKE 'spaces:%'
--   --      — and note this direction is the DANGEROUS one: it is exactly the
--   --      `spaces:`-anchored pass warned against above. Restrict it to the
--   --      seven columns below; never let it near a manifest.
--   -- realm: 'end_user:app_' || substring(realm FROM 14) WHERE realm LIKE 'end\_user:spc\_%'
--   -- storage keys: regexp_replace(…, '^([^/]+)/spc_', '\1/app_') etc.
--   -- reason: 'application_deleted' WHERE reason = 'space_deleted'
--   -- level: 'application' WHERE level = 'space'  (disable
--   --      `oauth_clients_level_immutable`; and re-add the three CHECKs
--   --      NOT VALID first, per `0053`'s ROLLBACK section, or the level
--   --      UPDATE fails against the now-VALID new-vocabulary constraints)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ═══ VERIFY — EVERY QUERY COUNTS BOTH HALVES ═══
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `0001` shipped a check that returned 0 for the intended outcome AND for the
-- wrong one, so it reported success either way. "A verification that cannot
-- distinguish the two results it is meant to choose between is not one."
-- Every query below therefore reports the OLD form going to zero AND the NEW
-- form reaching the expected total, and each block adds a cross-check that
-- catches the THIRD outcome — the half-rewrite that is neither form.
--
-- ── A. the id re-mint ────────────────────────────────────────────────────────
--   Before: legacy = N_rel, renamed = 0.   After: legacy = 0, renamed = N_rel.
--   `total` must be IDENTICAL before and after — no row may appear or vanish.
--
--   SELECT 'spaces.id' AS col,
--          count(*) FILTER (WHERE id LIKE 'app\_%')  AS legacy,
--          count(*) FILTER (WHERE id LIKE 'spc\_%')  AS renamed,
--          count(*)                                  AS total
--     FROM spaces
--   UNION ALL SELECT 'api_keys.space_id',                  count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM api_keys
--   UNION ALL SELECT 'audit_events.space_id',              count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM audit_events
--   UNION ALL SELECT 'end_users.space_id',                 count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM end_users
--   UNION ALL SELECT 'files.space_id',                     count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM files
--   UNION ALL SELECT 'integration_connections.space_id',   count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM integration_connections
--   UNION ALL SELECT 'integration_oauth_clients.space_id', count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM integration_oauth_clients
--   UNION ALL SELECT 'integration_org_defaults.space_id',  count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM integration_org_defaults
--   UNION ALL SELECT 'integration_pins.space_id',          count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM integration_pins
--   UNION ALL SELECT 'notifications.space_id',             count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM notifications
--   UNION ALL SELECT 'oauth_clients.referenced_space_id',  count(*) FILTER (WHERE referenced_space_id LIKE 'app\_%'), count(*) FILTER (WHERE referenced_space_id LIKE 'spc\_%'), count(*) FROM oauth_clients
--   UNION ALL SELECT 'package_persistence.space_id',       count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM package_persistence
--   UNION ALL SELECT 'package_schedules.space_id',         count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM package_schedules
--   UNION ALL SELECT 'runs.space_id',                      count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM runs
--   UNION ALL SELECT 'space_packages.space_id',            count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM space_packages
--   UNION ALL SELECT 'space_smtp_configs.space_id',        count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM space_smtp_configs
--   UNION ALL SELECT 'space_social_providers.space_id',    count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM space_social_providers
--   UNION ALL SELECT 'uploads.space_id',                   count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM uploads
--   UNION ALL SELECT 'webhooks.space_id',                  count(*) FILTER (WHERE space_id LIKE 'app\_%'), count(*) FILTER (WHERE space_id LIKE 'spc\_%'), count(*) FROM webhooks;
--
-- ── B. the third outcome for the id: neither form ────────────────────────────
--   `legacy = 0` alone does NOT prove the rewrite landed — a truncated or
--   doubly-applied prefix also reports 0. Both of these must be 0 BEFORE and
--   AFTER (before, every id is `app_…`; after, every id is `spc_…`):
--
--   SELECT count(*) FROM spaces WHERE id !~ '^(app|spc)_';
--   SELECT count(*) FROM spaces WHERE id LIKE 'spc\_app\_%' OR id LIKE 'app\_spc\_%';
--
-- ── C. the FKs came back, all eighteen, with their behaviour ─────────────────
--   Identical output before and after. `confdeltype` is `a`=no action,
--   `c`=cascade, `n`=set null: seventeen `c` and ONE `n` (audit_events).
--
--   SELECT count(*) FROM pg_constraint
--    WHERE confrelid = 'public.spaces'::regclass AND contype = 'f';     -- 18
--   SELECT conrelid::regclass::text AS child, conname, confdeltype, confupdtype
--     FROM pg_constraint
--    WHERE confrelid = 'public.spaces'::regclass AND contype = 'f'
--    ORDER BY 1;
--
-- ── D. every surviving id is a CANONICAL space id ────────────────────────────
--   The check the loose `LIKE 'app\_%'` match traded away, moved here so a
--   non-canonical survivor is REPORTED instead of silently skipped. This is
--   exactly the shape `assertSpaceId` enforces at request time, so a non-zero
--   result names every space that will 400 after the deploy.
--
--   SELECT id FROM spaces
--    WHERE id !~ '^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--   -- After: zero rows. Before: every row (they are all `app_…`) — so run it
--   -- as an AFTER check only, and read a non-empty result as "these spaces
--   -- were never minted by prefixedId and need an operator decision", not as
--   -- "the script failed".
--
-- ── E. permission scopes — both halves, plus the negative control ────────────
--   Before: legacy = N, renamed = M.   After: legacy = 0, renamed = M + N
--   (M + N, not M — unless a credential already carried both spellings, which
--   `array_agg(DISTINCT …)` collapses; compare against `total` too).
--
--   SELECT 'api_keys' AS rel,
--          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'applications:%')) AS legacy,
--          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'spaces:%'))       AS renamed
--     FROM api_keys
--   UNION ALL SELECT 'oauth_clients',        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'spaces:%')) FROM oauth_clients
--   UNION ALL SELECT 'oauth_consents',       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'spaces:%')) FROM oauth_consents
--   UNION ALL SELECT 'oauth_refresh_tokens', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'spaces:%')) FROM oauth_refresh_tokens
--   UNION ALL SELECT 'oauth_access_tokens',  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE 'spaces:%')) FROM oauth_access_tokens
--   UNION ALL SELECT 'cli_refresh_tokens',   count(*) FILTER (WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(scope, '\s+') t WHERE t LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(scope, '\s+') t WHERE t LIKE 'spaces:%')) FROM cli_refresh_tokens WHERE scope IS NOT NULL
--   UNION ALL SELECT 'device_codes',         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(scope, '\s+') t WHERE t LIKE 'applications:%')), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM regexp_split_to_table(scope, '\s+') t WHERE t LIKE 'spaces:%')) FROM device_codes WHERE scope IS NOT NULL;
--
--   NEGATIVE CONTROL — values that merely CONTAIN the word. Must be IDENTICAL
--   before and after; a change here is a bare-replace() bug:
--
--   SELECT (SELECT count(*) FROM api_keys      WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE '%applications:%' AND s NOT LIKE 'applications:%')),
--          (SELECT count(*) FROM oauth_clients WHERE EXISTS (SELECT 1 FROM unnest(scopes) s WHERE s LIKE '%applications:%' AND s NOT LIKE 'applications:%')),
--          (SELECT count(*) FROM device_codes  WHERE scope IS NOT NULL AND EXISTS (SELECT 1 FROM regexp_split_to_table(scope,'\s+') t WHERE t LIKE '%applications:%' AND t NOT LIKE 'applications:%'));
--
-- ── F. realms — both halves, plus the cross-check ────────────────────────────
--   Before: A, 0, B, 0.   After: 0, A, 0, B.
--
--   SELECT (SELECT count(*) FROM "user"    WHERE realm LIKE 'end\_user:app\_%'),
--          (SELECT count(*) FROM "user"    WHERE realm LIKE 'end\_user:spc\_%'),
--          (SELECT count(*) FROM "session" WHERE realm LIKE 'end\_user:app\_%'),
--          (SELECT count(*) FROM "session" WHERE realm LIKE 'end\_user:spc\_%');
--
--   CROSS-CHECK — a realm that names a space no longer in `spaces`. This is the
--   query that catches the third outcome: rewrite the ids and forget the realm
--   (or the reverse) and every end-user session becomes dangling, which
--   `assertUserRealm` turns into a rejected login. Whatever this returns, it
--   must return the SAME number before and after (it is not necessarily 0 —
--   `oidc_end_user_profiles.auth_user_id` is ON DELETE SET NULL, so a `user`
--   row can outlive the space named in its realm):
--
--   SELECT (SELECT count(*) FROM "user" u
--             WHERE u.realm LIKE 'end\_user:%'
--               AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = substring(u.realm FROM 10))),
--          (SELECT count(*) FROM "session" x
--             WHERE x.realm LIKE 'end\_user:%'
--               AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = substring(x.realm FROM 10)));
--
--   And the realms that are NOT end-user realms must not move at all:
--   SELECT realm, count(*) FROM "user" WHERE realm NOT LIKE 'end\_user:%' GROUP BY 1 ORDER BY 1;
--
-- ── G. storage keys — the cross-check is the whole point ─────────────────────
--   Before: legacy = N, renamed = 0.   After: legacy = 0, renamed = N.
--
--   SELECT 'files'   AS rel, count(*) FILTER (WHERE storage_key ~ '^[^/]+/app_') AS legacy,
--                            count(*) FILTER (WHERE storage_key ~ '^[^/]+/spc_') AS renamed, count(*) AS total FROM files
--   UNION ALL
--   SELECT 'uploads',        count(*) FILTER (WHERE storage_key ~ '^[^/]+/app_'),
--                            count(*) FILTER (WHERE storage_key ~ '^[^/]+/spc_'), count(*) FROM uploads;
--
--   CROSS-CHECK — the key's space segment against the row's own `space_id`.
--   MUST be 0 BEFORE AND AFTER. This is the discriminator: it holds in both
--   consistent states and is non-zero in exactly the mangled one (key rewritten
--   but id not, id rewritten but key not, or a filename that happened to be
--   caught). A single-number "legacy = 0" check cannot see any of that.
--
--   SELECT (SELECT count(*) FROM files   WHERE split_part(storage_key, '/', 2) <> space_id),
--          (SELECT count(*) FROM uploads WHERE split_part(storage_key, '/', 2) <> space_id);
--
--   The outbox has no `space_id` to join against, so it gets both halves plus a
--   leak check on the buckets the anchor must NOT reach:
--
--   SELECT count(*) FILTER (WHERE storage_key LIKE 'app\_%') AS legacy,
--          count(*) FILTER (WHERE storage_key LIKE 'spc\_%') AS renamed,
--          count(*)                                          AS total
--     FROM storage_deletion_jobs WHERE bucket IN ('files', 'uploads');
--   SELECT bucket, count(*) FROM storage_deletion_jobs
--    WHERE bucket NOT IN ('files', 'uploads') AND storage_key LIKE 'spc\_%'
--    GROUP BY 1;   -- zero rows before AND after
--
-- ── H. the deletion reason ───────────────────────────────────────────────────
--   Before: N, 0.   After: 0, N.
--   SELECT (SELECT count(*) FROM storage_deletion_jobs WHERE reason = 'application_deleted'),
--          (SELECT count(*) FROM storage_deletion_jobs WHERE reason = 'space_deleted');
--
-- ── I. the `level` vocabulary, and the constraints it gates ──────────────────
--   Before: A, x, B, y.   After: 0, x + A, 0, y + B.
--   SELECT (SELECT count(*) FROM webhooks      WHERE level = 'application'),
--          (SELECT count(*) FROM webhooks      WHERE level = 'space'),
--          (SELECT count(*) FROM oauth_clients WHERE level = 'application'),
--          (SELECT count(*) FROM oauth_clients WHERE level = 'space');
--
--   STRUCTURAL CROSS-CHECK — the three constraints `0053` left `NOT VALID`.
--   Before: three rows, all `convalidated = false`. After: all `true`. A `true`
--   here is proof the whole table was re-scanned and holds no legacy literal,
--   which no `count(*) = 0` query can establish on its own.
--
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname IN ('webhooks_level_values', 'webhooks_level_check', 'oauth_clients_level_check')
--    ORDER BY 1;
--
-- ── J. the append-only record was NOT rewritten ──────────────────────────────
--   Both must be IDENTICAL before and after, and both are expected to be > 0 on
--   any deployment with history. A zero here after the run means someone
--   "finished the job" — see WHAT THIS DELIBERATELY DOES NOT REWRITE.
--
--   SELECT (SELECT count(*) FROM audit_events WHERE resource_type = 'application'),
--          (SELECT count(*) FROM audit_events WHERE action LIKE 'application.%');
--
-- ── K. the triggers are back on ──────────────────────────────────────────────
--   `tgenabled` must be `O` for all four, before AND after.
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgname IN ('oauth_clients_level_immutable', 'runs_notify_update_trigger',
--                     'runs_notify_insert_trigger', 'integration_connections_notify_trigger')
--    ORDER BY 1;

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — the `level` vocabulary. FIRST, because `0053` left three CHECK
-- constraints NOT VALID and a NOT VALID constraint is still enforced on every
-- UPDATE: a row holding `level = 'application'` rejects the id rewrite in step
-- 3 until its level is legal. See ORDER IS LOAD-BEARING in the header.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "webhooks" SET "level" = 'space' WHERE "level" = 'application';

-- `oauth_clients_level_immutable` (BEFORE UPDATE, FOR EACH ROW) RAISES on any
-- change to `level`. Disabled for exactly this one statement.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'oauth_clients_level_immutable'
      AND tgrelid = 'public.oauth_clients'::regclass
  ) THEN
    ALTER TABLE "oauth_clients" DISABLE TRIGGER "oauth_clients_level_immutable";
  END IF;
END $$;

UPDATE "oauth_clients" SET "level" = 'space' WHERE "level" = 'application';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'oauth_clients_level_immutable'
      AND tgrelid = 'public.oauth_clients'::regclass
  ) THEN
    ALTER TABLE "oauth_clients" ENABLE TRIGGER "oauth_clients_level_immutable";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — silence the two NOTIFY triggers that fire on `space_id` changing.
-- Left on, step 3 queues one pg_notify per historical run and per integration
-- connection, all delivered at COMMIT to every live SSE subscriber.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'runs_notify_update_trigger' AND tgrelid = 'public.runs'::regclass
  ) THEN
    ALTER TABLE "runs" DISABLE TRIGGER "runs_notify_update_trigger";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'integration_connections_notify_trigger'
      AND tgrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE "integration_connections" DISABLE TRIGGER "integration_connections_notify_trigger";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 — capture the foreign keys into `spaces`, verbatim, then drop them.
-- Catalog-driven: `pg_get_constraintdef()` is replayed as-is in step 5, so each
-- key's exact ON DELETE behaviour is preserved by construction rather than by a
-- list that could be wrong. `ON COMMIT DROP` ties the capture to this
-- transaction — a rollback takes it with it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE "_spaces_fk_backup" ON COMMIT DROP AS
SELECT c.conname::text                                              AS conname,
       quote_ident(n.nspname) || '.' || quote_ident(t.relname)      AS tbl,
       a.attname::text                                              AS colname,
       pg_get_constraintdef(c.oid)                                  AS def,
       array_length(c.conkey, 1)                                    AS ncols
  FROM pg_constraint c
  JOIN pg_class t          ON t.oid = c.conrelid
  JOIN pg_namespace n      ON n.oid = t.relnamespace
  JOIN LATERAL unnest(c.conkey) AS k(attnum) ON TRUE
  JOIN pg_attribute a      ON a.attrelid = t.oid AND a.attnum = k.attnum
 WHERE c.contype = 'f'
   AND c.confrelid = 'public.spaces'::regclass;

DO $$
DECLARE
  r record;
  n integer;
BEGIN
  SELECT count(*) INTO n FROM "_spaces_fk_backup";
  IF n = 0 THEN
    RAISE EXCEPTION
      'No foreign key into `spaces` found. Either 0053_applications_to_spaces has not been applied, or a previous half-run left the constraints dropped — do not continue without restoring them.';
  END IF;
  IF EXISTS (SELECT 1 FROM "_spaces_fk_backup" WHERE ncols <> 1) THEN
    RAISE EXCEPTION
      'A COMPOSITE foreign key into `spaces` exists; this script rewrites single-column keys only. Extend it deliberately rather than letting the loop below rewrite one column of a pair.';
  END IF;
  RAISE NOTICE 'Dropping % foreign key(s) into spaces (expected 18 at the time this script was written).', n;
  FOR r IN SELECT conname, tbl FROM "_spaces_fk_backup" ORDER BY tbl, conname LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4 — re-mint the id. Parent first, then every child column, with the SAME
-- transform, so the reference survives. `LIKE 'app\_%'` escapes the underscore;
-- unescaped, `_` is LIKE's single-character wildcard.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "spaces" SET "id" = 'spc_' || substring("id" FROM 5) WHERE "id" LIKE 'app\_%';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT tbl, colname FROM "_spaces_fk_backup" ORDER BY tbl, colname LOOP
    EXECUTE format(
      'UPDATE %s SET %I = %L || substring(%I FROM 5) WHERE %I LIKE %L',
      r.tbl, r.colname, 'spc_', r.colname, r.colname, 'app\_%'
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5 — restore the foreign keys from the captured definitions, then ASSERT
-- that every one came back. Guarded on non-existence so a partially applied
-- environment converges; the assertion is what stops a silent partial restore.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
  expected integer;
  actual integer;
BEGIN
  FOR r IN SELECT conname, tbl, def FROM "_spaces_fk_backup" ORDER BY tbl, conname LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace nsp ON nsp.oid = t.relnamespace
      WHERE c.conname = r.conname
        AND quote_ident(nsp.nspname) || '.' || quote_ident(t.relname) = r.tbl
    ) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, r.def);
    END IF;
  END LOOP;

  SELECT count(*) INTO expected FROM "_spaces_fk_backup";
  SELECT count(*) INTO actual
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass;
  IF actual <> expected THEN
    RAISE EXCEPTION
      'Foreign key restore incomplete: captured %, found % after restore.', expected, actual;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6 — the NOTIFY triggers back on, before anything else can fail.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'runs_notify_update_trigger' AND tgrelid = 'public.runs'::regclass
  ) THEN
    ALTER TABLE "runs" ENABLE TRIGGER "runs_notify_update_trigger";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'integration_connections_notify_trigger'
      AND tgrelid = 'public.integration_connections'::regclass
  ) THEN
    ALTER TABLE "integration_connections" ENABLE TRIGGER "integration_connections_notify_trigger";
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7 — persisted permission scope strings, in the two shapes `0046`
-- established. `applications:` is 13 characters, hence `substring(… FROM 14)`.
-- Anchored on the whole ELEMENT / whole TOKEN starting with the LEGACY
-- spelling, so `myapplications:read` and a client id containing the word are
-- untouchable, and `workspaces:read` (Monday, Typeform) is never in reach.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "api_keys"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'applications:%' THEN 'spaces:' || substring(s FROM 14)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'applications:%');

UPDATE "oauth_clients"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'applications:%' THEN 'spaces:' || substring(s FROM 14)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'applications:%');

UPDATE "oauth_consents"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'applications:%' THEN 'spaces:' || substring(s FROM 14)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'applications:%');

UPDATE "oauth_refresh_tokens"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'applications:%' THEN 'spaces:' || substring(s FROM 14)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'applications:%');

UPDATE "oauth_access_tokens"
SET "scopes" = (
  SELECT COALESCE(array_agg(DISTINCT CASE
    WHEN s LIKE 'applications:%' THEN 'spaces:' || substring(s FROM 14)
    ELSE s
  END), '{}'::text[])
  FROM unnest("scopes") AS s
)
WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS s WHERE s LIKE 'applications:%');

UPDATE "cli_refresh_tokens"
SET "scope" = (
  SELECT string_agg(d.tok, ' ' ORDER BY d.pos)
  FROM (
    SELECT
      CASE WHEN t LIKE 'applications:%' THEN 'spaces:' || substring(t FROM 14) ELSE t END AS tok,
      min(ord) AS pos
    FROM regexp_split_to_table("scope", '\s+') WITH ORDINALITY AS x(t, ord)
    WHERE t <> ''
    GROUP BY 1
  ) d
)
WHERE "scope" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM regexp_split_to_table("scope", '\s+') AS t
    WHERE t LIKE 'applications:%'
  );

UPDATE "device_codes"
SET "scope" = (
  SELECT string_agg(d.tok, ' ' ORDER BY d.pos)
  FROM (
    SELECT
      CASE WHEN t LIKE 'applications:%' THEN 'spaces:' || substring(t FROM 14) ELSE t END AS tok,
      min(ord) AS pos
    FROM regexp_split_to_table("scope", '\s+') WITH ORDINALITY AS x(t, ord)
    WHERE t <> ''
    GROUP BY 1
  ) d
)
WHERE "scope" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM regexp_split_to_table("scope", '\s+') AS t
    WHERE t LIKE 'applications:%'
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8 — the two realm columns. `session.realm` is a DENORMALISED COPY of
-- `user.realm` captured at session-create time, and the request-time guard
-- (`assertUserRealm`) reads it: rewriting only one of the two rejects every
-- live end-user session. `end_user:app_` is 13 characters, hence FROM 14.
-- Both underscores are escaped in the anchor.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "user"
SET "realm" = 'end_user:spc_' || substring("realm" FROM 14)
WHERE "realm" LIKE 'end\_user:app\_%';

UPDATE "session"
SET "realm" = 'end_user:spc_' || substring("realm" FROM 14)
WHERE "realm" LIKE 'end\_user:app\_%';

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9 — storage keys.
--
-- `files.storage_key`   = `files/{spaceId}/{fileId}/{safeName}`
-- `uploads.storage_key` = `uploads/{spaceId}/{uploadId}/{safeName}`
--
-- Both are written as `${BUCKET}/${path}` and split back apart by
-- `parseStorageKey` (`services/files.ts:108,171`; `services/uploads.ts:71,255`),
-- so the space id is the SECOND segment. Anchored by POSITION with a regex
-- pinned to `^` — the same shape `0044` used for `^([^/]+)/documents/` — so a
-- file whose NAME contains `app_` can never be rewritten. `[^/]+` rather than a
-- hardcoded bucket: the position is what makes the match correct, not the
-- bucket's spelling.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "files"
SET "storage_key" = regexp_replace("storage_key", '^([^/]+)/app_', '\1/spc_')
WHERE "storage_key" ~ '^[^/]+/app_';

UPDATE "uploads"
SET "storage_key" = regexp_replace("storage_key", '^([^/]+)/app_', '\1/spc_')
WHERE "storage_key" ~ '^[^/]+/app_';

-- The outbox stores the key WITHIN the bucket (no bucket prefix — see the
-- column comment in `schema/storage-deletion-jobs.ts`), so the space id is
-- segment ONE, not two. Restricted to the two buckets whose keys begin with a
-- space id: `run-workspace` keys begin with a RUN id, and `agent-packages` /
-- `library-packages` keys begin with an owner namespace. Without the bucket
-- filter this anchor would reach all three.
UPDATE "storage_deletion_jobs"
SET "storage_key" = 'spc_' || substring("storage_key" FROM 5)
WHERE "bucket" IN ('files', 'uploads')
  AND "storage_key" LIKE 'app\_%';

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 10 — the deletion reason. A free-text audit/metric label; the only cost
-- of leaving it would be an operator's `GROUP BY reason` split across two
-- spellings of one event. EXACT equality, never a substring rewrite — `0044`
-- step 4, same table, same argument.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE "storage_deletion_jobs"
SET "reason" = 'space_deleted'
WHERE "reason" = 'application_deleted';

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 11 — promote the three CHECK constraints `0053` was forced to add
-- NOT VALID. Their tables now hold no legacy literal, so the deferred
-- full-table verification can finally run. `VALIDATE CONSTRAINT` on an
-- already-valid constraint is a no-op, so a replay costs one catalog lookup.
--
-- These three statements are the reason `0053`'s header ends with "DEPLOYING
-- THIS MIGRATION ALONE IS NOT A DEPLOY". After they succeed, `convalidated` is
-- true for all three — which is the one check that proves the whole table was
-- re-scanned rather than merely that a COUNT came back zero.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_level_values' AND conrelid = 'public.webhooks'::regclass
  ) THEN
    ALTER TABLE "webhooks" VALIDATE CONSTRAINT "webhooks_level_values";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_level_check' AND conrelid = 'public.webhooks'::regclass
  ) THEN
    ALTER TABLE "webhooks" VALIDATE CONSTRAINT "webhooks_level_check";
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oauth_clients_level_check' AND conrelid = 'public.oauth_clients'::regclass
  ) THEN
    ALTER TABLE "oauth_clients" VALIDATE CONSTRAINT "oauth_clients_level_check";
  END IF;
END $$;

COMMIT;
