// SPDX-License-Identifier: Apache-2.0

/**
 * How a running turn reads, like a coding agent's status line: the step in progress, the turn's
 * clock; and the title a settled reasoning keeps. Pure: the thread's headers draw what these return.
 */

import { formatDuration } from "@appstrate/core/format";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import type { ChatTranslate } from "./runtime-context.ts";
import { showCall } from "./tool-presentation.ts";
import { deriveToolPhase } from "./tool-result.ts";

/**
 * The turn's elapsed time in whole seconds, from 1 s on: under it every turn would open on « 0 ms »,
 * and a live clock in tenths would flicker. From a minute on, `formatDuration` already counts whole seconds.
 */
export function turnClock(elapsedMs: number | undefined, lang: string): string | undefined {
  if (elapsedMs === undefined || elapsedMs < 1000) return undefined;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds >= 60) return formatDuration(seconds * 1000, lang);
  return new Intl.NumberFormat(lang, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
  }).format(seconds);
}

/**
 * When the turn of the message at `index` started, as ISO (a string for `useAuiState`): its user
 * message's creation, the message just before it; the message's own without one.
 */
export function turnStartOf(
  messages: readonly { readonly role: string; readonly createdAt?: Date }[],
  index: number,
): string | undefined {
  const asked = messages[index - 1];
  return (asked?.role === "user" ? asked : messages[index])?.createdAt?.toISOString();
}

/** The step a part is: a tool call named by {@link showCall}, anything else the model thinking. */
export function showStep(
  part: { readonly type: string; readonly toolName?: string; readonly args?: unknown },
  presentation: ToolPresentation | undefined,
  t: ChatTranslate,
): { label: string; idText?: string } {
  if (part.type !== "tool-call" || !part.toolName) return { label: t("reasoning.running") };
  const { label, idText } = showCall({ toolName: part.toolName, args: part.args, presentation }, t);
  return idText ? { label, idText } : { label };
}

/** A call still in progress (running, or awaiting its result): its line shimmers. */
export function isCallInProgress(part: Parameters<typeof deriveToolPhase>[0]): boolean {
  const phase = deriveToolPhase(part);
  return phase === "running" || phase === "pending";
}

/** A line's markdown marks: heading, quote and list markers ahead, emphasis and code around words. */
const LEADING_MARKS = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /\*\*|__|~~|[*`]|(?<![\w])_|_(?![\w])/g;

/** A line of reasoning as words, without its markdown; "" when it holds none. */
function wordsOf(line: string): string {
  return line.trim().replace(LEADING_MARKS, "").replace(LINK, "$1").replace(EMPHASIS, "").trim();
}

/** The first line of a reasoning text that reads as words, without its markdown; "" when none. */
export function reasoningTitle(text: string): string {
  // Lazily, line by line: a long reasoning is not split past its title.
  for (const [line] of text.matchAll(/^.*$/gm)) {
    const title = wordsOf(line);
    if (title) return title;
  }
  return "";
}

/** The first title among the reasoning parts of `parts` at `indices`; "" when none reads as words. */
export function reasoningTitleAt(
  parts: readonly { readonly type: string; readonly text?: string }[],
  indices: Iterable<number>,
): string {
  for (const i of indices) {
    const part = parts[i];
    const title = part?.type === "reasoning" ? reasoningTitle(part.text ?? "") : "";
    if (title) return title;
  }
  return "";
}

/** A reasoning text holds a second line of words: more than its title says. */
export function reasoningSaysMore(text: string): boolean {
  let lines = 0;
  for (const [line] of text.matchAll(/^.*$/gm)) {
    if (wordsOf(line) && ++lines > 1) return true;
  }
  return false;
}
