// SPDX-License-Identifier: Apache-2.0

/**
 * What the plugin's `SessionStart` hook says. The hook only `cat`s this file,
 * so it holds the hook's finished output. It lives outside the plugin tree for
 * two reasons: the plugin's version is the hash of its contents (D6), and
 * Claude Code runs a cached COPY of the plugin that a failed sync never
 * touches — the file is how a failure still reaches the next session.
 *
 * Every notice closes its own loop: after the fix, `PLUGIN_UPDATE_COMMAND`
 * re-runs the sync, which clears the file, and a new session picks up the result.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { loginRemedy } from "../api.ts";
import { getDataDir } from "../config.ts";
import { shellArg } from "../shell.ts";
import { getNoticePath } from "./state.ts";
import { PLUGIN_NAME, PLUGIN_UPDATE_COMMAND, SETUP_SLUG } from "./targets.ts";

/** Claude Code's `SessionStart` hook output: one line for the user, context for the model. */
export interface SessionNotice {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

/**
 * A problem one command fixes. A human reads it on stderr and Claude runs it
 * from a shell with no TTY, so `remedy` never prompts: `ask` is what to ask the
 * user for first (the `<…>` placeholder in `remedy`), and `check` is a
 * non-interactive command that succeeds once the problem is gone.
 */
export interface Actionable {
  problem: string;
  remedy: string;
  ask?: string;
  check?: string;
}

const INSTANCE_QUESTION =
  "their Appstrate instance URL (`https://app.appstrate.com` for the hosted service)";

/** The re-login the API errors name, plus how to tell it is already done. */
export function loginFix(problem: string, profileName: string, instance?: string): Actionable {
  return {
    problem,
    remedy: loginRemedy(profileName, instance),
    check: `appstrate whoami --profile ${shellArg(profileName)}`,
    ...(instance ? {} : { ask: INSTANCE_QUESTION }),
  };
}

const SWITCHES = {
  org: {
    command: "appstrate org switch <org-id-or-slug>",
    ask: "the organization to use (`appstrate org list` lists them)",
  },
  space: {
    command: "appstrate space switch <space-id>",
    ask: "the space to use (`appstrate space list` lists them)",
  },
};

/**
 * `org switch` / `space switch` open a picker unless given a ref, and a picker
 * needs a TTY. `--profile`, or Claude would re-pin whichever profile is active.
 */
export function switchFix(
  problem: string,
  pin: keyof typeof SWITCHES,
  profileName: string,
): Actionable {
  const { command, ask } = SWITCHES[pin];
  return { problem, remedy: `${command} --profile ${shellArg(profileName)}`, ask };
}

/** Every notice ends the same way, with the fix and how it takes effect; only the leads differ. */
function render(
  { remedy, ask, check }: Actionable,
  lead: { user: string; model: string },
  tail = "",
): SessionNotice {
  const update = `\`${PLUGIN_UPDATE_COMMAND}\``;
  return {
    systemMessage: `${lead.user} run \`${remedy}\` (or ask Claude to), then ${update}, then start a new Claude Code session.`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `${lead.model} This may already be fixed: ` +
        (check
          ? `if \`${check}\` succeeds, it is; skip to the last step. `
          : "if the user already fixed it, skip to the last step. ") +
        `Otherwise offer to run \`${remedy}\` for the user` +
        (ask ? `, asking them for ${ask} first` : "") +
        `. Last step: ${update}, which re-runs the sync and clears this notice; ` +
        "the new skills and connection take effect in a new Claude Code session." +
        tail,
    },
  };
}

/**
 * `stale`: the run failed, so the installed skills stay as the last successful
 * sync left them. The time is absolute because the hook cannot compute an age,
 * and the notice it prints may predate a fix, or the sync running beside it.
 */
export function syncProblemNotice(
  fix: Actionable,
  { stale }: { stale: boolean },
  at = new Date(),
): SessionNotice {
  const stamp = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return render(fix, {
    user: stale
      ? `Appstrate skills did not sync on ${stamp}: ${fix.problem}. They stay as they are until a sync succeeds:`
      : `Appstrate skills synced on ${stamp}, but: ${fix.problem}. To fix it,`,
    model:
      `The Appstrate plugin sync of ${stamp} reported: ${fix.problem}.` +
      (stale ? " Its skills and agent commands stay as last synced until a sync succeeds." : ""),
  });
}

/** What a setup plugin's session start says, to the user and to the model. */
export function setupNotice(fix: Actionable): SessionNotice {
  return render(
    fix,
    {
      user: `Appstrate skills: this machine is not connected (${fix.problem}). To connect it,`,
      model: `The ${PLUGIN_NAME} plugin is installed but not connected: ${fix.problem}.`,
    },
    ` The /${PLUGIN_NAME}:${SETUP_SLUG} skill has the details.`,
  );
}

/** Atomic: the hook may read it while it is being replaced. */
export async function writeNotice(notice: SessionNotice): Promise<void> {
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(getNoticePath(), `${JSON.stringify(notice)}\n`, { mode: 0o600 });
}

export async function clearNotice(): Promise<void> {
  await rm(getNoticePath(), { force: true });
}
