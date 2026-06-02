// SPDX-License-Identifier: Apache-2.0

/**
 * Shared tool-parity set diff, used by both the local (`mcp-server`) and
 * remote (`integration` + `source.kind:remote`) handlers.
 *
 * Two directions:
 *   - declared ⊄ provided → FAIL. The manifest names a tool the server does
 *     not expose (typo, or upstream removed it). Always a hard failure.
 *   - provided ⊄ declared → FAIL, unless `allowUndeclared` (the manifest's
 *     `allow_undeclared_tools: true`), in which case WARN. An undeclared tool
 *     the agent author hasn't reviewed/scoped is worth surfacing either way.
 */

import type { Finding } from "./types.ts";

export interface DiffOptions {
  /** Check name stamped on each finding. */
  check: string;
  /** When true, server tools missing from the manifest are WARN, not FAIL. */
  allowUndeclared?: boolean;
}

export function diffToolSets(
  packageId: string,
  declared: string[],
  provided: string[],
  options: DiffOptions,
): Finding[] {
  const findings: Finding[] = [];
  const providedSet = new Set(provided);
  const declaredSet = new Set(declared);

  for (const name of declared) {
    if (!providedSet.has(name)) {
      findings.push({
        packageId,
        check: options.check,
        severity: "fail",
        message: `declared tool "${name}" is not exposed by the server`,
      });
    }
  }
  for (const name of provided) {
    if (!declaredSet.has(name)) {
      findings.push({
        packageId,
        check: options.check,
        severity: options.allowUndeclared ? "warn" : "fail",
        message: `server exposes undeclared tool "${name}"${
          options.allowUndeclared ? "" : " (add it to the manifest)"
        }`,
      });
    }
  }
  return findings;
}
