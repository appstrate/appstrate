// SPDX-License-Identifier: Apache-2.0

import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import type { PackageTypeConfig } from "./config.ts";

/**
 * Build the manifest a newly created package row stores, from the author
 * manifest. Pure — no DB, no logger — so the canonical-writer contract
 * (`display_name`, never `displayName`) is testable without the wiring
 * `createOrgItem` needs.
 *
 * `manifest.type` MUST already equal `cfg.type`. It is the manifest's identity
 * AND the discriminator `validateManifest` dispatches on, so rewriting it after
 * validation turned a manifest valid for one type into a stored manifest no
 * schema accepts (issue #987) — hence the invariant instead of a repair.
 *
 * `$schema` is still stamped: it is a tooling pointer the platform owns, not
 * author content, and with `type` guaranteed it is a normalization rather than
 * an override. `name` defaults to the package id; `item.name` /
 * `item.description`, when given, override the manifest's `display_name` /
 * `description`.
 */
export function buildStoredManifest(
  manifest: Record<string, unknown>,
  cfg: PackageTypeConfig,
  item: { id: string; name?: string; description?: string },
): Record<string, unknown> {
  if (manifest.type !== cfg.type) {
    // Unreachable over HTTP — every route gates the author manifest's `type`
    // against its own package type (`validateManifestForRoute`), and the one
    // caller whose source can legitimately drift (`forkPackage`, reading an
    // immutable published snapshot) normalizes before calling. So this is a
    // broken invariant, not client input: a plain Error, never an ApiError.
    throw new Error(
      `Manifest type mismatch for '${item.id}': expected "${cfg.type}", received "${String(manifest.type)}"`,
    );
  }

  const stored: Record<string, unknown> = { ...manifest };
  stored.$schema = AFPS_SCHEMA_URLS[cfg.type];
  if (!stored.name) stored.name = item.id;
  if (item.name) stored.display_name = item.name;
  if (item.description) stored.description = item.description;
  return stored;
}
