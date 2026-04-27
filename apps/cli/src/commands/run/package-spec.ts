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

const PACKAGE_ID_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*(?:@(.+))?$/;

/** Result of classifying `<arg>` for `appstrate run`. */
export type ParsedRunTarget =
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
      /** Raw spec after `@`, or undefined when only `@scope/name` was given. */
      spec: string | undefined;
    };

export class PackageSpecError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "PackageSpecError";
  }
}

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
    const match = PACKAGE_ID_RE.exec(trimmed);
    if (!match) {
      throw new PackageSpecError(
        `"${trimmed}" is not a valid package id`,
        "Expected @scope/name[@<version|tag|range>] (e.g. @system/hello-world, @scope/agent@1.2.3).",
      );
    }
    const head = match[1] ? trimmed.slice(0, trimmed.length - match[1].length - 1) : trimmed;
    // head is `@scope/name`; split deliberately — slash is the only valid separator.
    const [scope, name] = head.split("/") as [string, string];
    return {
      kind: "id",
      packageId: head,
      scope,
      name,
      spec: match[1],
    };
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
