-- 0005 — give every stored AFPS `delivery.http.prefix` that is a bare auth
-- scheme its separator: `"Bearer"` → `"Bearer "`, in `package_versions.manifest`
-- and `packages.draft_manifest`.
--
-- REHEARSED AND APPLIED — production, 2026-08-28, in the v1.0.0-beta.54 window.
-- README step 4 was run on a restored `pg_dump` of the database about to be
-- written, as this file's own text demanded (it does NOT qualify for `0004`'s
-- exemption: reachable production databases hold these rows, which is the
-- entire reason it exists).
--
-- Measured, identical on the rehearsal copy and on production: **126
-- `package_versions.manifest` + 77 `packages.draft_manifest`**, both "verify
-- after" counts 0, and a replay reporting `UPDATE 0` twice.
--
-- It was applied FIRST, against the still-running beta.53 platform, per the
-- box below — the outage window for doing so is zero, and the window for
-- deferring it is the length of the deploy.
--
-- What HAS been rehearsed is the STATEMENT, on a synthetic fixture rather than
-- on real data: applied twice on `postgres:16-alpine` over every shape named
-- below — bare `Bearer` / `Basic` / `Zoho-oauthtoken`, `Proxy-Authorization`, a
-- lowercased header name, one manifest carrying a bare and a correct auth side
-- by side, and the must-not-touch shapes (`"Token token="`, `Cookie: session`,
-- `auths: {}`, `auths: []`, no `auths`, no `prefix`). 4 matching rows per table
-- moved, second run 0, no row nulled, every must-not-touch shape byte-identical
-- afterwards. That is evidence about the semantics and nothing else — not about
-- the shapes production actually holds, and not about lock or timeout behaviour
-- at production row counts. Step 4 is what covers those.
--
-- ═══ WHY ═══
--
-- AFPS §7.6 defines `prefix` as a LITERAL prepended to the rendered value, so an
-- auth-scheme prefix must carry its own separator. The injector
-- (`planHttpDeliveryInjection`, packages/afps-runtime/src/resolvers/
-- http-delivery.ts) used to notice a bare RFC 9110 token in `Authorization`
-- position and insert the missing SP. That repair is gone — §1, one accepted
-- form — and the manifest validator now REFUSES a bare scheme at install time
-- (`integrationManifestSchema` gate (1d), packages/core/src/integration.ts),
-- naming `"Bearer "` as the replacement. §5: the old form fails loudly instead
-- of being made to work.
--
-- This file is the §2 half — the data the code change leaves behind. Be exact
-- about what that data does now, because it is NOT a degradation anyone can
-- schedule at leisure. Gate (1d) lives on `integrationManifestSchema`, and every
-- read path re-parses the stored jsonb through that schema. So a row written
-- before the gate does not resolve to `Authorization: BearerTOKEN` and collect
-- 401s — it does not parse, and therefore does not LOAD. Three surfaces, three
-- different faces:
--
--   `GET /api/integrations/{id}` → 404. `getIntegration` narrows the column
--     through `asIntegrationManifest`, gets null, and `loadManifestOrThrow`
--     raises "not found in this organization". Loud, but it names the wrong
--     cause: the integration presents as MISSING, not as mis-spelled. Pinned by
--     "refuses a stored manifest whose Authorization prefix is a bare auth
--     scheme" in apps/api/test/integration/routes/integrations.test.ts.
--
--   `GET /api/integrations` → the row is silently OMITTED. `listIntegrations`
--     `continue`s past it behind a warn log, so the integration simply vanishes
--     from the dashboard. This is the one surface that says nothing at all.
--
--   Run kickoff → refused, and this is the surface that names the field. Every
--     origin — platform (`routes/runs.ts`), scheduled (`scheduler.ts`), remote
--     and inline (`routes/runs-remote.ts`) — reaches `validateAgentReadiness`,
--     whose #737 manifest-health gate maps the failure to
--     `integration_invalid_manifest` inside the 412
--     `missing_integration_connection` envelope with the Zod issue APPENDED
--     verbatim. That message is the only place a human is told
--     `auths.<key>.delivery.http.prefix` and `Write "Bearer "`. A SCHEDULE
--     fails the same way with nobody in the loop: `triggerScheduledRun` turns
--     the ApiError into `failSchedule`, one visible failed run per fire, for as
--     long as the schedule exists.
--
-- The spawn resolver's own `drop("invalid_manifest")` therefore never fires for
-- this defect — readiness refuses the kickoff before the spawn is reached. It
-- stays as defense in depth, not as the observed behaviour.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THIS BELONGS IN THE DEPLOY WINDOW, NOT IN A BACKLOG.                      │
-- │ Gate (1d) ships in the SAME change as this file and takes effect the      │
-- │ moment the new platform boots. From that instant every affected           │
-- │ integration is a 404 on its detail route, absent from the list, and       │
-- │ un-runnable — and its schedules start recording failed runs. This script  │
-- │ is the repair for that, so the two are ONE DEPLOY, the way                │
-- │ `0053_applications_to_spaces.sql` and `0003` are.                         │
-- │                                                                           │
-- │ Unlike `0003` the two halves are ORDER-FREE, and running this one FIRST   │
-- │ is strictly better. It needs no schema this change adds, and the form it  │
-- │ writes renders IDENTICALLY under the old code: the repair being removed   │
-- │ inserted one SP after a bare token and left an already-spaced prefix      │
-- │ alone, so `"Bearer"` and `"Bearer "` both emitted `Bearer <token>`.       │
-- │ Applied against the still-running old platform, the outage window is      │
-- │ zero; applied afterwards, it lasts as long as the gap.                    │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ═══ SCOPE ═══
--
-- Two columns, because they are the only two places a manifest is stored
-- verbatim and read back at run time:
--
--   `package_versions.manifest`  — read by `readIntegrationManifestAt`
--                                  ({ kind: "version" }) for a run pinned to a
--                                  published version.
--   `packages.draft_manifest`    — read by `fetchIntegrationManifestUncached`
--                                  for an unpinned / soft-resolved integration.
--
-- Nothing else holds one. `integration_connections` stores an `auth_key` and
-- encrypted fields, never a manifest; `runs.resolved_integration_versions` is a
-- `{version, source}` POINTER, not a snapshot.
--
-- System packages are swept too — the `WHERE` is the condition, not the origin
-- — but the sweep is inert for them: `resolvePublishedManifest` short-circuits
-- a system id on the in-memory boot registry and never consults
-- `package_versions` at all, so their stale rows (the boot sync only ever
-- INSERTs/UPSERTs, it never prunes) are already unreachable. The system
-- population moved with the version bumps that shipped alongside this file.
--
-- What this does NOT touch: the `.afps` archive bytes an org uploaded, and
-- therefore not `package_versions.integrity` (a SHA-256 over the ARCHIVE, not
-- over this jsonb) — so the boot sync's refuse-overwrite guard is unaffected.
-- The archive keeps the author's original spelling; re-importing it now fails
-- loudly at the install gate, which is the intended outcome, not a regression.
--
-- Idempotent: the `WHERE` is exactly the condition the `UPDATE` removes, so a
-- second run matches zero rows. The rewrite rebuilds `auths` with
-- `jsonb_object_agg` and touches only the entries that match — every other auth
-- key, and every other key of a matching auth, is carried through unchanged.
--
-- ONE COUPLING A FUTURE EDITOR MUST NOT BREAK: the `EXISTS` in each `WHERE`
-- below is also what keeps that statement's `SET` subquery safe.
-- `jsonb_object_agg` over an empty set returns NULL, and `jsonb_set(m,
-- '{auths}', NULL)` returns NULL — so a row whose `auths` is `{}`, which passes
-- `jsonb_typeof(...) = 'object'` and yields zero `jsonb_each` rows, would have
-- its ENTIRE manifest nulled. Both halves confirmed on `postgres:16-alpine`.
-- `EXISTS` is the only thing guaranteeing at least one row reaches the
-- aggregate, and it does so from a different clause than the one it protects.
-- Relax it — widen it to a plain `auths` presence test, drop it in favour of a
-- cheaper guard — and this arms silently. Nothing else in the statement catches
-- it.
--
-- The pattern is the RFC 9110 `token` grammar (`-` last so it is a literal in
-- the bracket expression, `'` doubled for SQL). A prefix that is nothing but a
-- token is a scheme missing its SP; anything containing a character outside it
-- — `"Token token="`, `"session="` — is a deliberate composite literal and is
-- left alone, as is a bare prefix on any header other than the two auth ones
-- (`Cookie: session` is correct as written).
--
-- ═══ VERIFY ═══
--
-- Before — the rows this will rewrite. Run per table; record both numbers:
--   SELECT count(*) FROM package_versions pv
--   WHERE jsonb_typeof(pv.manifest -> 'auths') = 'object'
--     AND EXISTS (SELECT 1 FROM jsonb_each(pv.manifest -> 'auths') AS e
--       WHERE lower(e.value #>> '{delivery,http,name}') IN ('authorization','proxy-authorization')
--         AND e.value #>> '{delivery,http,prefix}' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$');
--   -- same query against packages / draft_manifest
--
-- After — both MUST be 0. Re-running this file must then report UPDATE 0.
--
-- Spot-check what moved (expect every listed prefix to end in a space):
--   SELECT pv.package_id, pv.version, e.key,
--          e.value #>> '{delivery,http,name}'   AS header,
--          e.value #>> '{delivery,http,prefix}' AS prefix
--   FROM package_versions pv, jsonb_each(pv.manifest -> 'auths') AS e
--   WHERE jsonb_typeof(pv.manifest -> 'auths') = 'object'
--     AND lower(e.value #>> '{delivery,http,name}') IN ('authorization','proxy-authorization')
--   ORDER BY 1, 2;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

UPDATE "package_versions" pv
SET "manifest" = jsonb_set(
      pv."manifest",
      '{auths}',
      (
        SELECT jsonb_object_agg(
                 e.key,
                 CASE
                   WHEN lower(e.value #>> '{delivery,http,name}')
                          IN ('authorization', 'proxy-authorization')
                    AND e.value #>> '{delivery,http,prefix}' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$'
                   THEN jsonb_set(
                          e.value,
                          '{delivery,http,prefix}',
                          to_jsonb((e.value #>> '{delivery,http,prefix}') || ' ')
                        )
                   ELSE e.value
                 END
               )
        FROM jsonb_each(pv."manifest" -> 'auths') AS e
      )
    )
WHERE jsonb_typeof(pv."manifest" -> 'auths') = 'object'
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(pv."manifest" -> 'auths') AS e
    WHERE lower(e.value #>> '{delivery,http,name}') IN ('authorization', 'proxy-authorization')
      AND e.value #>> '{delivery,http,prefix}' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$'
  );

UPDATE "packages" p
SET "draft_manifest" = jsonb_set(
      p."draft_manifest",
      '{auths}',
      (
        SELECT jsonb_object_agg(
                 e.key,
                 CASE
                   WHEN lower(e.value #>> '{delivery,http,name}')
                          IN ('authorization', 'proxy-authorization')
                    AND e.value #>> '{delivery,http,prefix}' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$'
                   THEN jsonb_set(
                          e.value,
                          '{delivery,http,prefix}',
                          to_jsonb((e.value #>> '{delivery,http,prefix}') || ' ')
                        )
                   ELSE e.value
                 END
               )
        FROM jsonb_each(p."draft_manifest" -> 'auths') AS e
      )
    )
WHERE jsonb_typeof(p."draft_manifest" -> 'auths') = 'object'
  AND EXISTS (
    SELECT 1
    FROM jsonb_each(p."draft_manifest" -> 'auths') AS e
    WHERE lower(e.value #>> '{delivery,http,name}') IN ('authorization', 'proxy-authorization')
      AND e.value #>> '{delivery,http,prefix}' ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$'
  );

COMMIT;
