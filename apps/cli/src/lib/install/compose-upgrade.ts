// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate install --upgrade-compose` (issue #515) — strip stale
 * duplicated env defaults from an operator's on-disk
 * `<dir>/docker-compose.yml` without touching `.env`, without running
 * Docker, and without disturbing any operator-added blocks.
 *
 * The repair itself is pure (`rewriteStaleComposeDefaults` in
 * `../compose-defaults.ts`): it only ever shortens the specific
 * `- VAR=${VAR:-default}` lines that mirror a code default, so services,
 * volumes, comments, and any hand-added env are preserved verbatim.
 * Anything that can't be cleanly auto-fixed is REFUSED (reported, not
 * guessed at) — the "refuses with a diff if it can't cleanly merge"
 * half of the issue's proposal.
 *
 * This module is the thin I/O wrapper around that pure core: read the
 * file, back it up, atomically rewrite. All side effects are injectable
 * so the orchestration is unit-testable without a real install dir.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultInstallDir } from "./project.ts";
import { atomicReplace, backupFiles } from "./upgrade.ts";
import {
  rewriteStaleComposeDefaults,
  type ComposeFixApplied,
  type ComposeFixRefused,
} from "../compose-defaults.ts";

/** Compose file name relative to the install dir — single source. */
const COMPOSE_FILE = "docker-compose.yml";

export type ComposeUpgradeStatus =
  /** No `<dir>/docker-compose.yml` — nothing to upgrade (likely Tier 0 or wrong dir). */
  | "no-install"
  /** File is already clean of removable duplicated defaults. */
  | "clean"
  /** Duplicated defaults were found and stripped (file rewritten + backed up). */
  | "upgraded"
  /** Duplicated defaults exist but NONE were auto-fixable — file left untouched. */
  | "refused-only";

export interface ComposeUpgradeOutcome {
  status: ComposeUpgradeStatus;
  /** Absolute path to the compose file that was (or would be) rewritten. */
  composePath: string;
  /** Lines rewritten to bare passthroughs. */
  applied: ComposeFixApplied[];
  /** Duplicated defaults that need a human edit (mapping form, etc.). */
  refused: ComposeFixRefused[];
  /** Absolute path to the `.backup` written before an upgrade, if any. */
  backupPath?: string;
}

export interface ComposeUpgradeDeps {
  /** Read the compose file content, or `null` when it does not exist. */
  readComposeFile?: (path: string) => Promise<string | null>;
  /** Copy `<dir>/<name>` → `<dir>/<name>.backup`; returns names backed up. */
  backup?: (dir: string, files: string[]) => Promise<string[]>;
  /** Atomically replace the compose file with new content. */
  writeComposeFile?: (path: string, body: string) => Promise<void>;
}

/** Default reader — `null` on ENOENT, rethrow other I/O errors. */
async function defaultReadComposeFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Run the compose upgrade for an install rooted at `dir`.
 *
 * Never runs Docker and never writes `.env` — applying the refreshed
 * compose to a running stack is left to the operator (`docker compose
 * up -d` / `appstrate restart`), surfaced by `formatComposeUpgradeResult`.
 */
export async function runComposeUpgrade(
  dir: string,
  deps: ComposeUpgradeDeps = {},
): Promise<ComposeUpgradeOutcome> {
  const absDir = resolve(dir);
  const composePath = join(absDir, COMPOSE_FILE);
  const read = deps.readComposeFile ?? defaultReadComposeFile;
  const backup = deps.backup ?? backupFiles;
  const write = deps.writeComposeFile ?? atomicReplace;

  const content = await read(composePath);
  if (content === null) {
    return { status: "no-install", composePath, applied: [], refused: [] };
  }

  const result = rewriteStaleComposeDefaults(content);

  if (!result.changed) {
    return {
      status: result.refused.length > 0 ? "refused-only" : "clean",
      composePath,
      applied: [],
      refused: result.refused,
    };
  }

  // Back up BEFORE the write so a crashed/killed process can never
  // leave the operator without a recoverable previous generation.
  const backedUp = await backup(absDir, [COMPOSE_FILE]);
  await write(composePath, result.newContent);

  return {
    status: "upgraded",
    composePath,
    applied: result.applied,
    refused: result.refused,
    ...(backedUp.includes(COMPOSE_FILE)
      ? { backupPath: join(absDir, `${COMPOSE_FILE}.backup`) }
      : {}),
  };
}

/**
 * Render a `ComposeUpgradeOutcome` as plain-text lines (the command
 * file frames it with clack). Mirrors `formatDoctorReport`'s "lib owns
 * the words, command owns the I/O" split.
 */
export function formatComposeUpgradeResult(outcome: ComposeUpgradeOutcome): string {
  const lines: string[] = [];

  switch (outcome.status) {
    case "no-install":
      lines.push(`No ${COMPOSE_FILE} found at ${outcome.composePath}.`);
      lines.push(``);
      lines.push(
        `--upgrade-compose only applies to a Docker-tier install. Pass --dir <path> if your`,
      );
      lines.push(`install lives elsewhere, or run \`appstrate install\` to create one.`);
      return lines.join("\n");

    case "clean":
      lines.push(`${outcome.composePath} is already clean — no stale duplicated defaults.`);
      return lines.join("\n");

    case "refused-only":
      lines.push(
        `Found ${outcome.refused.length} duplicated default(s) in ${outcome.composePath},`,
      );
      lines.push(`but none could be auto-fixed safely. Edit these lines by hand:`);
      for (const r of outcome.refused) {
        lines.push(`  • line ${r.line}: ${r.varName} — ${r.reason}`);
        lines.push(`      ${r.raw.trim()}`);
      }
      return lines.join("\n");

    case "upgraded":
      lines.push(
        `Rewrote ${outcome.composePath} — stripped ${outcome.applied.length} stale default(s):`,
      );
      for (const a of outcome.applied) {
        lines.push(`  • line ${a.line}: ${a.before.trim()}  →  ${a.after.trim()}`);
      }
      if (outcome.backupPath) {
        lines.push(``);
        lines.push(`Previous version saved to ${outcome.backupPath}.`);
      }
      if (outcome.refused.length > 0) {
        lines.push(``);
        lines.push(`${outcome.refused.length} default(s) need a manual edit (not auto-fixable):`);
        for (const r of outcome.refused) {
          lines.push(`  • line ${r.line}: ${r.varName} — ${r.reason}`);
        }
      }
      lines.push(``);
      lines.push(
        `Apply to a running stack:  cd ${resolve(outcome.composePath, "..")} && docker compose up -d`,
      );
      lines.push(`(or: appstrate restart)`);
      return lines.join("\n");
  }
}

/** Resolve the upgrade-compose target dir: `--dir` or `~/appstrate`. */
export function resolveComposeUpgradeDir(rawDir: string | undefined): string {
  return resolve(rawDir ?? defaultInstallDir());
}
