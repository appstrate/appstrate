// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Generic 3-step semver resolution: exact match → dist-tag → semver range.
 *
 * Re-exported from `@appstrate/afps-shared` — the single source of truth
 * shared with `@appstrate/core/semver`. afps-runtime ships standalone; the
 * shared package is itself a zero-internal-dependency npm package, so this
 * import preserves standalone publishing while eliminating the former
 * hand-maintained copy.
 */

export { resolveVersionString } from "@appstrate/afps-shared/semver-resolve";
