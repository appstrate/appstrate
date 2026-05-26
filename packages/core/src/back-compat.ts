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
 *      ({@link import("./dependencies.ts").parseManifestIntegrations}) and
 *      `packages/core/src/form.ts`
 *      ({@link import("./form.ts").mapAfpsToRjsf}) MUST be removed.
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
 * Tracking: AFPS 2.0 migration window end-of-life.
 */
export const AFPS_1X_READ_FALLBACK_REMOVAL = "AFPS 2.1";
