// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate self-update` — bring the running CLI to a newer release.
 *
 * Channel dispatch follows the build-time stamp from `INSTALL_SOURCE`
 * (issue #249, phase 1). Only the curl channel can self-update; other
 * channels exit non-zero with a hint so the user invokes the right
 * package manager. See `docs/cli/upgrades.md` for the full matrix.
 */

import * as clack from "@clack/prompts";
import { INSTALL_SOURCE, upgradeHint, type InstallSource } from "../lib/install-source.ts";
import { CLI_VERSION } from "../lib/version.ts";
import {
  detectPlatform,
  performCurlUpdate,
  resolveTargetVersion,
  defaultSelfUpdateDeps,
  type PerformCurlUpdateResult,
  type PlatformInfo,
  type SelfUpdateDeps,
  type ResolveTargetVersionDeps,
} from "../lib/self-update.ts";

export interface SelfUpdateOptions {
  /** Specific version to install. Default: latest published release. */
  version?: string;
  /** Reinstall even if the current version equals the target. */
  force?: boolean;
  /** Override the build-time stamp for tests. */
  source?: InstallSource;
  /** Override the deps for tests (network, fs, exec). */
  deps?: SelfUpdateDeps;
  /** Override the running CLI version for tests. Defaults to bundled `CLI_VERSION`. */
  currentVersion?: string;
  /** Override platform detection for tests. Production reads `process.platform/arch`. */
  platform?: PlatformInfo;
  /** Logger override for tests; production uses `console.error`. */
  log?: (line: string) => void;
}

/**
 * Exit-code contract for `appstrate self-update`. Distinct codes for
 * configuration-class failures (wrong channel / no stamp — `2`) vs runtime
 * update failures (network / verification / disk — `1`) so shell scripts
 * can branch on `case $?` without parsing stderr. Mirrors the rustup
 * convention (1 = transient/runtime, 2 = configuration / wrong context).
 */
export const SELF_UPDATE_EXIT = {
  OK: 0,
  UPDATE_FAILED: 1,
  WRONG_CHANNEL: 2,
  UNKNOWN_SOURCE: 2,
} as const;

export interface SelfUpdateRunResult {
  exitCode: number;
  message: string;
  detail?: PerformCurlUpdateResult;
}

/**
 * Pure entry point — returns an exit code + message instead of mutating
 * `process.exit` directly so the test surface stays simple. The thin wrapper
 * `selfUpdateCommand` (registered in `cli.ts`) does the I/O and exits.
 */
export async function runSelfUpdate(opts: SelfUpdateOptions = {}): Promise<SelfUpdateRunResult> {
  const source = opts.source ?? INSTALL_SOURCE;

  if (source === "bun") {
    return {
      exitCode: SELF_UPDATE_EXIT.WRONG_CHANNEL,
      message: [
        `This appstrate CLI was installed via the npm channel.`,
        `\`self-update\` only manages the curl-channel binary — running it`,
        `here would desync the npm package metadata from the binary on disk.`,
        ``,
        `Upgrade with:`,
        `  ${upgradeHint("bun")}`,
      ].join("\n"),
    };
  }

  if (source === "unknown") {
    const execPath = (opts.deps ?? defaultSelfUpdateDeps).execPath();
    return {
      exitCode: SELF_UPDATE_EXIT.UNKNOWN_SOURCE,
      message: [
        `Cannot self-update: this binary has no install-source stamp.`,
        `It was either built from source (\`bun run dev\`, \`bun apps/cli/src/cli.ts\`)`,
        `or copied from one channel to another, which we cannot reason about safely.`,
        ``,
        `Diagnostic:`,
        `  Running binary: ${execPath}`,
        `  CLI version:    ${CLI_VERSION}`,
        ``,
        `Reinstall via the curl channel to enable self-update:`,
        `  ${upgradeHint("unknown")}`,
      ].join("\n"),
    };
  }

  // source === "curl"
  const deps = opts.deps ?? defaultSelfUpdateDeps;
  const resolveDeps: ResolveTargetVersionDeps = { fetchText: deps.fetchText.bind(deps) };
  let target: string;
  try {
    target = await resolveTargetVersion(opts.version, resolveDeps);
  } catch (err) {
    return {
      exitCode: SELF_UPDATE_EXIT.UPDATE_FAILED,
      message: `Could not resolve target version: ${(err as Error).message}`,
    };
  }

  const platform = opts.platform ?? detectPlatform();
  let result: PerformCurlUpdateResult;
  try {
    result = await performCurlUpdate({
      targetVersion: target,
      platform,
      force: opts.force === true,
      deps,
      currentVersion: opts.currentVersion,
      log: opts.log,
    });
  } catch (err) {
    return {
      exitCode: SELF_UPDATE_EXIT.UPDATE_FAILED,
      message: `Update failed: ${(err as Error).message}`,
    };
  }

  if (result.status === "already-up-to-date") {
    return {
      exitCode: SELF_UPDATE_EXIT.OK,
      message: `Already on appstrate ${result.version}. Pass --force to reinstall.`,
      detail: result,
    };
  }
  return {
    exitCode: SELF_UPDATE_EXIT.OK,
    message: `Updated appstrate to ${result.version} (${result.destination})`,
    detail: result,
  };
}

/**
 * Commander entry point — does the I/O. Wraps `runSelfUpdate` so a successful
 * call exits 0 and a failure exits with the chosen non-zero code.
 */
export async function selfUpdateCommand(opts: SelfUpdateOptions = {}): Promise<never> {
  clack.intro(`Appstrate self-update`);
  const result = await runSelfUpdate(opts);
  if (result.exitCode === SELF_UPDATE_EXIT.OK) {
    clack.outro(result.message);
  } else {
    clack.cancel(result.message);
  }
  process.exit(result.exitCode);
}
