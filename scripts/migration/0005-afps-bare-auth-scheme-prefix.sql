-- 0005 — give every stored AFPS `delivery.http.prefix` that is a bare auth
-- scheme its separator: `"Bearer"` → `"Bearer "`, in `package_versions.manifest`
-- and `packages.draft_manifest`.
--
-- NOT REHEARSED AGAINST A PRODUCTION DUMP, and the counts below are therefore
-- UNMEASURED — the operator measures their own with the "verify before" query,
-- on their own database, before running anything. What WAS rehearsed is the
-- statement itself: applied twice against a PGlite fixture covering every shape
-- below (bare `Bearer`/`Basic`/`Zoho-oauthtoken`, `Proxy-Authorization`, a
-- lowercased header name, a manifest with one bare and one correct auth, and
-- the four must-not-touch shapes), 6 matching rows per table → 0, second run 0.
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
-- This file is the §2 half — the data the code change leaves behind. Without
-- it, an integration whose manifest was stored BEFORE the gate existed keeps
-- resolving to `Authorization: BearerTOKEN`, which every upstream answers with
-- a 401 the agent reports as "the API is unavailable". A silent 401 on a live
-- integration is exactly the failure the loud-refusal rule exists to prevent,
-- so the stored form has to move.
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
