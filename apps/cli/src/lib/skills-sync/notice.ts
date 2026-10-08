// SPDX-License-Identifier: Apache-2.0

/** What the plugin's `SessionStart` hook prints (`state.ts` keeps the file). */

import type { Actionable } from "../remedy.ts";
import { PLUGIN_UPDATE_COMMAND } from "./targets.ts";

/** Claude Code's `SessionStart` hook output: one line for the user, context for the model. */
export interface SessionNotice {
  systemMessage: string;
  hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
}

export type NoticeKind = "failed" | "warned" | "setup";

/** The time is absolute: the hook cannot compute an age. */
export function renderNotice(
  { problem, remedy }: Actionable,
  kind: NoticeKind,
  at = new Date(),
): SessionNotice {
  const stamp = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const lead = {
    failed: `Appstrate skills did not sync on ${stamp}: ${problem}.`,
    warned: `Appstrate skills synced on ${stamp}, but: ${problem}.`,
    setup: `Appstrate skills: this machine is not connected (${problem}).`,
  }[kind];
  const update = `\`${PLUGIN_UPDATE_COMMAND}\``;
  return {
    systemMessage: `${lead} Run \`${remedy}\` (or ask Claude to), then ${update}, then start a new Claude Code session.`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `${lead} Offer to run \`${remedy}\` for the user, replacing any \`<placeholder>\` in it by ` +
        `asking them, then ${update}; the result takes effect in a new Claude Code session. ` +
        `If the user already fixed it, only ${update} and a new session are needed.`,
    },
  };
}
