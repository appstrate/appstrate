// SPDX-License-Identifier: Apache-2.0

/**
 * One-time runtime warning when more than one `appstrate` is on `$PATH`
 * (issue #249, phase 5).
 *
 * The bootstrap pre-check (phase 4) covers the "user installs curl
 * AFTER having bun" path. This module covers the reverse — "user has
 * curl, runs `bun install -g appstrate` later" — by surfacing a
 * non-blocking warning the first time a dual-install state is detected.
 *
 * Design choices:
 *   - **Shallow scan, not deep probe.** We split `$PATH`, check
 *     executability, and resolve realpaths. No subprocess per-binary
 *     introspection (which `doctor` does); that would cost ~50-200ms
 *     per startup. The shallow scan is ~10ms and scales with PATH length.
 *   - **One-time ack.** Once the user has been warned about a given set
 *     of installations, we stop nagging until the SET CHANGES (added or
 *     removed an install). The ack is keyed on the sorted realpaths so
 *     a fresh dual-install state re-arms the warning.
 *   - **Skip on machine-readable commands.** `--version`, `--help`,
 *     `completion`, `doctor`, and the hidden `__install-source` must NOT
 *     emit a banner because their stdout/stderr is parsed by tooling.
 *   - **Hard kill switch.** `APPSTRATE_NO_DUAL_INSTALL_CHECK=1` disables
 *     the check entirely — used by tests and by users who deliberately
 *     run a multi-install setup.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config.ts";
import { findAppstrateOnPath, type PathScanFs } from "./path-scan.ts";
import { upgradeHint } from "./install-source.ts";

const ACK_FILENAME = "dual-install-ack.json";

/** Subcommands whose output is parsed by humans / tooling — never warn here. */
export const SILENT_SUBCOMMANDS = new Set(["doctor", "completion", "__install-source"]);

/** Help/version flags that bypass the warning. */
export const SILENT_FLAGS = new Set(["--version", "-V", "--help", "-h"]);

export interface ShouldSkipArgs {
  /** Commander's `program.args` after parsing — first non-flag is the subcommand. */
  args: string[];
  /** Raw `process.argv.slice(2)` — used to catch top-level `--help`/`--version` before commander resolves a subcommand. */
  rawArgv: string[];
}

export function shouldSkipDualInstallCheck(input: ShouldSkipArgs): boolean {
  if (process.env.APPSTRATE_NO_DUAL_INSTALL_CHECK === "1") return true;
  for (const arg of input.rawArgv) {
    if (SILENT_FLAGS.has(arg)) return true;
  }
  const sub = input.args[0];
  if (sub && SILENT_SUBCOMMANDS.has(sub)) return true;
  return false;
}

export interface DualInstallAck {
  /** Sorted realpaths of every installation present at ack time. */
  paths: string[];
  /** ISO timestamp the user was last warned. */
  warnedAt: string;
}

export interface AckStore {
  read(): Promise<DualInstallAck | null>;
  write(ack: DualInstallAck): Promise<void>;
}

export const defaultAckStore: AckStore = {
  async read() {
    const path = join(getConfigDir(), ACK_FILENAME);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as { paths?: unknown; warnedAt?: unknown };
      if (!Array.isArray(parsed.paths)) return null;
      const paths = parsed.paths.filter((p): p is string => typeof p === "string");
      const warnedAt = typeof parsed.warnedAt === "string" ? parsed.warnedAt : "";
      if (!warnedAt) return null;
      return { paths, warnedAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Anything else (corrupt JSON, perm denied) → treat as no-ack and
      // re-warn. Avoids a stale ack file silently suppressing the banner.
      return null;
    }
  },
  async write(ack) {
    const path = join(getConfigDir(), ACK_FILENAME);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(ack, null, 2));
    await rename(tmp, path);
  },
};

export interface RunDualInstallCheckOptions {
  pathEnv?: string;
  pathSeparator?: string;
  binaryName?: string;
  pathScanFs?: PathScanFs;
  ackStore?: AckStore;
  /** Override the timestamp written to the ack file (tests). */
  now?: () => Date;
}

export interface DualInstallWarning {
  message: string;
  paths: string[];
}

/**
 * Run the check. Returns a warning when:
 *   - more than one distinct installation exists on $PATH,
 *   - AND the set of paths differs from the last ack'd set.
 *
 * Caller is expected to print `warning.message` to stderr and immediately
 * commit the ack (so a Ctrl-C between print and ack still leaves the user
 * informed but doesn't re-warn forever).
 */
export async function runDualInstallCheck(
  opts: RunDualInstallCheckOptions = {},
): Promise<DualInstallWarning | null> {
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const sep = opts.pathSeparator ?? (process.platform === "win32" ? ";" : ":");
  const binaryName = opts.binaryName ?? "appstrate";
  const fs = opts.pathScanFs;
  const store = opts.ackStore ?? defaultAckStore;

  const hits = await findAppstrateOnPath(pathEnv, binaryName, fs, sep);
  if (hits.length <= 1) return null;

  const realPaths = hits.map((h) => h.realPath).sort();
  const ack = await store.read();
  if (ack && pathsEqual(ack.paths.slice().sort(), realPaths)) {
    return null;
  }

  const lines: string[] = [];
  lines.push(`! Multiple \`appstrate\` installations detected on $PATH (${hits.length} entries):`);
  for (const hit of hits) {
    lines.push(`    ${hit.binary}`);
  }
  lines.push(`! Run \`appstrate doctor\` for the full report.`);
  lines.push(`! To upgrade the npm-channel binary: ${upgradeHint("bun")}`);
  lines.push(`! Silence this warning: APPSTRATE_NO_DUAL_INSTALL_CHECK=1`);

  return {
    message: lines.join("\n"),
    paths: realPaths,
  };
}

function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Persist an ack so subsequent CLI runs stay silent until the install set changes.
 */
export async function ackDualInstall(
  paths: string[],
  store: AckStore = defaultAckStore,
  now: () => Date = () => new Date(),
): Promise<void> {
  await store.write({ paths: paths.slice().sort(), warnedAt: now().toISOString() });
}
