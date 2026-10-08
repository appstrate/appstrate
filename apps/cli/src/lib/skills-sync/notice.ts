// SPDX-License-Identifier: Apache-2.0

/**
 * What the plugin's `SessionStart` hook says. The hook only `cat`s this file,
 * so it holds the hook's finished output. It lives outside the plugin tree for
 * two reasons: the plugin's version is the hash of its contents (D6), and
 * Claude Code runs a cached COPY of the plugin that a failed sync never
 * touches — the file is how a failure still reaches the next session.
 *
 * Every notice closes its own loop: after the fix, `PLUGIN_UPDATE_COMMAND`
 * re-runs the sync, which clears the file, and reloads the skills.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { getDataDir } from "../config.ts";
import { getNoticePath } from "./state.ts";
import { PLUGIN_NAME, PLUGIN_UPDATE_COMMAND, SETUP_SLUG, shellQuote } from "./targets.ts";

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

/**
 * An {@link Actionable} as the notice offers it to the model, which runs it
 * from a shell with no TTY: `remedy` must not prompt, `ask` is what to ask the
 * user for first (the `<…>` placeholder in `remedy`), and `check` is a
 * non-interactive command that succeeds once the problem is gone.
 */
export interface NoticeFix extends Actionable {
  ask?: string;
  check?: string;
}

const INSTANCE_QUESTION =
  "their Appstrate instance URL (`https://app.appstrate.com` for the hosted service)";

/** `login` prompts for the instance unless `--instance` names it. */
export function loginFix(problem: string, profileName: string, instance?: string): NoticeFix {
  return {
    problem,
    remedy: `appstrate login --profile ${profileName} --instance ${instance ? shellQuote(instance) : "<url>"}`,
    check: `appstrate whoami --profile ${profileName}`,
    ...(instance ? {} : { ask: INSTANCE_QUESTION }),
  };
}

const SWITCHES = {
  org: {
    remedy: "appstrate org switch <org-id-or-slug>",
    ask: "the organization to use (`appstrate org list` lists them)",
  },
  space: {
    remedy: "appstrate space switch <space-id>",
    ask: "the space to use (`appstrate space list` lists them)",
  },
};

/** `org switch` / `space switch` open a picker unless given a ref, and a picker needs a TTY. */
export function switchFix(problem: string, pin: keyof typeof SWITCHES): NoticeFix {
  return { problem, ...SWITCHES[pin] };
}

/**
 * Every notice ends the same way: the fix, and `PLUGIN_UPDATE_COMMAND` to
 * re-run the sync, which clears the notice. Only the leads differ.
 */
function render(
  { remedy, ask, check }: NoticeFix,
  lead: { user: string; model: string },
  tail = "",
): SessionNotice {
  const update = `\`${PLUGIN_UPDATE_COMMAND}\``;
  return {
    systemMessage: `${lead.user} run \`${remedy}\` (or ask Claude to), then ${update}.`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `${lead.model} This may already be fixed: ` +
        (check
          ? `if \`${check}\` succeeds, it is, and only ${update} is needed. `
          : `if the user already fixed it, only ${update} is needed. `) +
        `Otherwise offer to run \`${remedy}\` for the user` +
        (ask ? `, asking them for ${ask} first` : "") +
        `, then ${update}: it re-runs the sync, which clears this notice, and reloads the skills.` +
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
  fix: NoticeFix,
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
export function setupNotice(fix: NoticeFix): SessionNotice {
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
