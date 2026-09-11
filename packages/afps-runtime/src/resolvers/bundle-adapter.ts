// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Resolver helpers for looking up packages inside a {@link Bundle}.
 *
 * The spec {@link Bundle} is keyed by {@link PackageIdentity}
 * (`@scope/name@version`). Resolvers receive refs as `{ name, version }`
 * where `version` may be a semver range — `resolvePackageRef` finds the
 * single package in the bundle whose name matches, which is the
 * resolved version the builder committed to.
 */

import type { Bundle, BundlePackage } from "../bundle/types.ts";
import type { DependencyRef } from "@afps-spec/types";

/**
 * Find the package in the bundle whose manifest name matches the ref.
 * Returns `null` when no such package is present — callers decide the
 * error shape (skill vs tool vs provider surface distinct errors).
 *
 * The bundle builder resolves each declared dep to exactly one version,
 * so a single name should map to a single package. When multiple
 * versions of the same name are present (not expected under AFPS
 * but tolerated), the first one encountered wins — iteration order is
 * deterministic (Map preserves insertion order).
 */
export function resolvePackageRef(bundle: Bundle, ref: DependencyRef): BundlePackage | null {
  for (const pkg of bundle.packages.values()) {
    const name = (pkg.manifest as { name?: unknown }).name;
    if (name === ref.name) return pkg;
  }
  return null;
}
