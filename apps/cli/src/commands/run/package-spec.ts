// SPDX-License-Identifier: Apache-2.0

/**
 * Detect whether `appstrate run <arg>` was given a local file path or a
 * package id (`@scope/name[@spec]`). The CLI supports both invocation
 * shapes so users can either run a local `.afps`/`.afps-bundle` they
 * built (existing dev loop) or fetch the bundle by id from the pinned
 * Appstrate instance (UI parity).
 *
 * Detection rules — strict by design so a typo in a package id fails
 * fast instead of silently being read as a path:
 *
 *   - Starts with `./`, `../`, `/`, `~/` → path.
 *   - Matches `@scope/name[@spec]` regex → package id.
 *   - Anything else → path (so unscoped paths like `bundle.afps` keep
 *     working).
 *
 * The id regex enforces the same alphabet the registry uses
 * (`[a-z0-9][a-z0-9-]*` per scope/name segment) — see
 * `@appstrate/core/naming` for the canonical predicate. Reproducing it
 * here keeps the CLI runnable without reaching into the platform
 * package every parse.
 */

import { PackageSpecError, splitPackageSpec } from "../../lib/package-spec.ts";

const PACKAGE_ID_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Result of classifying `<arg>` for `appstrate run`. */
type ParsedRunTarget =
  | {
      kind: "path";
      path: string;
    }
  | {
      kind: "id";
      /** `@scope/name` (no version suffix). */
      packageId: string;
      scope: string;
      name: string;
      /**
       * Raw spec after `@`, or undefined when only `@scope/name` was given
       * — which means the latest published version. `draft` and `published`
       * are the platform's two reserved selectors and pass through as
       * written; everything else is a semver, a range or a dist-tag the
       * server resolves.
       */
      spec: string | undefined;
    };

export function parseRunTarget(raw: string): ParsedRunTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PackageSpecError(
      "Bundle argument is empty",
      "Pass a path (e.g. ./agent.afps-bundle) or a package id (e.g. @scope/name).",
    );
  }

  if (looksLikePath(trimmed)) {
    return { kind: "path", path: trimmed };
  }

  if (trimmed.startsWith("@")) {
    const { ref, spec } = splitPackageSpec(trimmed);
    if (!PACKAGE_ID_RE.test(ref)) {
      throw new PackageSpecError(
        `"${trimmed}" is not a valid package id`,
        "Expected @scope/name[@<version|tag|range|draft|published>] (e.g. @system/hello-world, @scope/agent@1.2.3, @scope/agent@draft).",
      );
    }
    // `ref` is `@scope/name`; the slash is the only valid separator.
    const [scope, name] = ref.split("/") as [string, string];
    return { kind: "id", packageId: ref, scope, name, spec };
  }

  // Unscoped: treat as path so `bundle.afps` (cwd-relative) keeps working.
  return { kind: "path", path: trimmed };
}

function looksLikePath(value: string): boolean {
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.startsWith("/")) return true;
  if (value.startsWith("~/")) return true;
  // Backslash on Windows-style paths.
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}
