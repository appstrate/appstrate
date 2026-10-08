// SPDX-License-Identifier: Apache-2.0

/**
 * What the plugin's `SessionStart` hook says. The hook only `cat`s this file,
 * so it holds the hook's finished output. It lives outside the plugin tree for
 * two reasons: the plugin's version is the hash of its contents (D6), and
 * Claude Code runs a cached COPY of the plugin that a failed sync never
 * touches — the file is how a failure still reaches the next session.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { getDataDir } from "../config.ts";

/** Claude Code's `SessionStart` hook output: one line for the user, context for the model. */
export interface SessionNotice {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

/** A problem the user fixes by running one command. */
export interface Actionable {
  problem: string;
  remedy: string;
}

export function getNoticePath(): string {
  return join(getDataDir(), "skills-sync", "notice.json");
}

/**
 * `stale`: the run failed, so the installed skills stay as the last successful
 * sync left them. The time is absolute because the hook cannot compute an age,
 * and the notice it prints may predate the sync running beside it.
 */
export function syncProblemNotice(
  { problem, remedy }: Actionable,
  { stale }: { stale: boolean },
  at = new Date(),
): SessionNotice {
  const stamp = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return {
    systemMessage: stale
      ? `Appstrate skills did not sync on ${stamp}: ${problem}. They stay as last synced until you run \`${remedy}\` — or ask Claude to run it for you.`
      : `Appstrate skills synced on ${stamp}, but: ${problem}. Run \`${remedy}\`, or ask Claude to run it for you.`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `The Appstrate plugin sync of ${stamp} reported: ${problem}. ` +
        (stale
          ? "Its skills and agent commands are frozen at the last successful sync until this is fixed. "
          : "") +
        `Offer to run \`${remedy}\` for the user; the next Claude Code session syncs again.`,
    },
  };
}

/** Atomic: the hook may read it while it is being replaced. */
export async function writeNotice(notice: SessionNotice): Promise<void> {
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(getNoticePath(), `${JSON.stringify(notice)}\n`, { mode: 0o600 });
}

export async function clearNotice(): Promise<void> {
  await rm(getNoticePath(), { force: true });
}
