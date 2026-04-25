// SPDX-License-Identifier: Apache-2.0

/**
 * Hidden subcommands used by `appstrate doctor` to introspect other
 * `appstrate` binaries on `$PATH` (issue #249, phase 3).
 *
 * `doctor` fork-execs each candidate it finds and parses the JSON output to
 * report the stamped install source. Older binaries (pre-phase-1) won't
 * recognise this command and exit non-zero with an error — `doctor` treats
 * that as `"unknown"` and renders accordingly.
 *
 * The contract is **stable JSON on stdout**: any change must be additive so
 * older `doctor` versions can still parse newer binaries.
 */

import { INSTALL_SOURCE } from "../lib/install-source.ts";
import { CLI_VERSION } from "../lib/version.ts";

export interface InternalInfoPayload {
  /** Bundled `CLI_VERSION` (from `package.json` baked at build). */
  version: string;
  /** Build-time install-source stamp. */
  source: "curl" | "bun" | "unknown";
  /** Schema version — bump on incompatible changes. */
  schema: 1;
}

export function buildInternalInfoPayload(): InternalInfoPayload {
  return {
    version: CLI_VERSION,
    source: INSTALL_SOURCE,
    schema: 1,
  };
}

export function internalInfoCommand(): never {
  process.stdout.write(`${JSON.stringify(buildInternalInfoPayload())}\n`);
  process.exit(0);
}
