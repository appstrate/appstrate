// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Back-compat sunset markers for pre-AFPS-2.0 read paths.
 *
 * Appstrate writes only AFPS 2.0 canonical (snake_case) manifests. A small
 * number of read sites still tolerate the pre-2.0 camelCase aliases so that
 * manifests written before the snake_case migration keep loading. Those read
 * fallbacks are scheduled for removal — this module gathers the removal
 * markers in one place so the deletion can be coordinated.
 *
 * Audit: §1.13 + §1.14 (back-compat reconciliation).
 */

/**
 * Pre-AFPS-2.0 camelCase manifest read paths are honored only through this
 * release. After this version ships:
 *
 *   1. A one-time DB backfill MUST run to upgrade every
 *      `package_versions.manifest` payload that still carries
 *      `providersConfiguration` / `fileConstraints` / `uiHints` /
 *      `propertyOrder` / `maxSize` to the canonical snake_case shape.
 *   2. The fallback reads in `packages/core/src/dependencies.ts`
 *      ({@link import("./dependencies.ts").parseManifestIntegrations} +
 *      the `dependencies.providers` / `dependencies.tools` 1.x→2.0
 *      Appendix-D projection in
 *      {@link import("./dependencies.ts").extractDependencies}) and
 *      `packages/core/src/form.ts`
 *      ({@link import("./form.ts").mapAfpsToRjsf}) MUST be removed.
 *   3. The frontend agent-editor fallback sites in
 *      `apps/web/src/components/agent-editor/utils.ts` MUST be removed:
 *      - line ~145: `m.display_name ?? m.displayName` in `manifestToMetadata`.
 *      - lines ~261-283: the legacy camelCase wrapper readers
 *        (`fileConstraints` / `uiHints` / `propertyOrder` / per-property
 *        `maxSize`) in `manifestToSchemaFields`.
 *      The writers in that same file (M8 — `metadataToManifestPatch`,
 *      `setRuntimeTools`, and `fieldsToSchema`) now strip the legacy
 *      camelCase siblings on every save, so these read-fallbacks remain the
 *      only tolerance layer for stored manifests that have not been
 *      re-saved since the 2.0 cutover.
 *
 * Writers are already AFPS 2.0 canonical only — see
 * {@link import("./dependencies.ts").writeManifestIntegrations} and the
 * `file_constraints`/`ui_hints`/`property_order` emitters in `form.ts`. The
 * read paths therefore only matter for stored manifests written before the
 * 2.0 cutover that have not been re-saved since.
 *
 * Backfill query shape (PostgreSQL, executed against `package_versions`):
 *
 * ```sql
 * -- Find candidates. Run as SELECT first to size the rewrite.
 * SELECT id, package_id, version
 *   FROM package_versions
 *  WHERE manifest @> '{"providersConfiguration":{}}'::jsonb
 *     OR manifest -> 'input'  ? 'fileConstraints'
 *     OR manifest -> 'input'  ? 'uiHints'
 *     OR manifest -> 'input'  ? 'propertyOrder'
 *     OR manifest -> 'output' ? 'fileConstraints'
 *     OR manifest -> 'config' ? 'fileConstraints';
 *
 * -- Rewrite in-place. Run inside a transaction.
 * UPDATE package_versions
 *    SET manifest = jsonb_set(
 *      manifest #- '{providersConfiguration}',
 *      '{integrations_configuration}',
 *      COALESCE(manifest -> 'integrations_configuration', '{}'::jsonb)
 *        || (manifest -> 'providersConfiguration')
 *    )
 *  WHERE manifest ? 'providersConfiguration';
 * -- (Form-level fileConstraints/uiHints/propertyOrder/maxSize rewrites
 * --  follow the same `jsonb_set` + `#-` pattern, applied per wrapper
 * --  location: input, output, config, agent config sections.)
 * ```
 *
 * Dependency-key backfill (AFPS 1.x → 2.0 Appendix D projection). Currently
 * masked by the read fallback in `extractDependencies` (see
 * `packages/core/src/dependencies.ts`); this backfill MUST run before that
 * fallback is removed in the {@link AFPS_1X_READ_FALLBACK_REMOVAL} release.
 * Applies to every JSONB column that stores an AFPS manifest:
 *
 *   - `packages.draft_manifest`            — editable draft (nullable)
 *   - `package_versions.manifest`          — published version snapshot
 *
 * NOT applicable: `application_packages.config` stores the resolved per-app
 * config payload (not a manifest snapshot), so it carries no
 * `dependencies.*` keys to project.
 *
 * The rewrite is idempotent — the `WHERE` clauses gate on the presence of the
 * legacy key, so re-running is a no-op once the projection has been applied.
 *
 * ```sql
 * -- 1. Dry-run: count affected rows per table + column.
 * SELECT
 *   (SELECT COUNT(*) FROM packages
 *      WHERE draft_manifest -> 'dependencies' ? 'providers'
 *         OR draft_manifest -> 'dependencies' ? 'tools')     AS packages_draft_legacy_deps,
 *   (SELECT COUNT(*) FROM package_versions
 *      WHERE manifest -> 'dependencies' ? 'providers'
 *         OR manifest -> 'dependencies' ? 'tools')           AS package_versions_legacy_deps;
 *
 * -- 2. Rewrite. Run inside a single transaction so a partial failure rolls
 * --    back the whole projection. Order matters: rename `providers` →
 * --    `integrations` and `tools` → `mcp_servers`, merging into any
 * --    already-present canonical key (Postgres `||` does shallow merge).
 *
 * BEGIN;
 *
 * -- packages.draft_manifest: providers → integrations
 * UPDATE packages
 *    SET draft_manifest = jsonb_set(
 *          draft_manifest,
 *          '{dependencies}',
 *          (draft_manifest -> 'dependencies') #- '{providers}'
 *            || jsonb_build_object(
 *                 'integrations',
 *                 COALESCE(draft_manifest -> 'dependencies' -> 'integrations', '{}'::jsonb)
 *                   || (draft_manifest -> 'dependencies' -> 'providers')
 *               )
 *        )
 *  WHERE draft_manifest -> 'dependencies' ? 'providers';
 *
 * -- packages.draft_manifest: tools → mcp_servers
 * UPDATE packages
 *    SET draft_manifest = jsonb_set(
 *          draft_manifest,
 *          '{dependencies}',
 *          (draft_manifest -> 'dependencies') #- '{tools}'
 *            || jsonb_build_object(
 *                 'mcp_servers',
 *                 COALESCE(draft_manifest -> 'dependencies' -> 'mcp_servers', '{}'::jsonb)
 *                   || (draft_manifest -> 'dependencies' -> 'tools')
 *               )
 *        )
 *  WHERE draft_manifest -> 'dependencies' ? 'tools';
 *
 * -- package_versions.manifest: providers → integrations
 * UPDATE package_versions
 *    SET manifest = jsonb_set(
 *          manifest,
 *          '{dependencies}',
 *          (manifest -> 'dependencies') #- '{providers}'
 *            || jsonb_build_object(
 *                 'integrations',
 *                 COALESCE(manifest -> 'dependencies' -> 'integrations', '{}'::jsonb)
 *                   || (manifest -> 'dependencies' -> 'providers')
 *               )
 *        )
 *  WHERE manifest -> 'dependencies' ? 'providers';
 *
 * -- package_versions.manifest: tools → mcp_servers
 * UPDATE package_versions
 *    SET manifest = jsonb_set(
 *          manifest,
 *          '{dependencies}',
 *          (manifest -> 'dependencies') #- '{tools}'
 *            || jsonb_build_object(
 *                 'mcp_servers',
 *                 COALESCE(manifest -> 'dependencies' -> 'mcp_servers', '{}'::jsonb)
 *                   || (manifest -> 'dependencies' -> 'tools')
 *               )
 *        )
 *  WHERE manifest -> 'dependencies' ? 'tools';
 *
 * COMMIT;
 *
 * -- 3. Post-check: every counter MUST return 0. Anything non-zero means a
 * --    legacy dep key survived the rewrite — investigate before removing the
 * --    read fallback in `extractDependencies`.
 * SELECT
 *   (SELECT COUNT(*) FROM packages
 *      WHERE draft_manifest -> 'dependencies' ? 'providers'
 *         OR draft_manifest -> 'dependencies' ? 'tools')     AS packages_draft_legacy_deps,
 *   (SELECT COUNT(*) FROM package_versions
 *      WHERE manifest -> 'dependencies' ? 'providers'
 *         OR manifest -> 'dependencies' ? 'tools')           AS package_versions_legacy_deps;
 * ```
 *
 * Tracking: AFPS 2.0 migration window end-of-life. Planned removal of the
 * read fallback (and execution of this backfill as a one-shot migration) is
 * scheduled for {@link AFPS_1X_READ_FALLBACK_REMOVAL}.
 */
export const AFPS_1X_READ_FALLBACK_REMOVAL = "AFPS 2.1";
