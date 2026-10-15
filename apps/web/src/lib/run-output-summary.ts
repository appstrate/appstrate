// SPDX-License-Identifier: Apache-2.0

/** The longest line a list cell or its tooltip carries; the run's own page has the rest. */
const MAX_LENGTH = 300;

/** One line of plain text: whitespace folded, the Markdown a model writes (list marker, emphasis, heading) dropped. */
function plainLine(markdown: string): string {
  return markdown
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-*+>#]+|\d+[.)])\s+/, "")
    .replace(/[*`]+/g, "");
}

export type RunOutputSummary = { kind: "text"; text: string } | { kind: "fields"; count: number };

/**
 * A readable line for a run's structured output, for a list: the first text the output holds,
 * else how many fields it has. Never the JSON itself. `null` when the run produced no output.
 */
export function summarizeRunOutput(result: unknown): RunOutputSummary | null {
  if (typeof result !== "object" || result === null) return null;
  const output = (result as { output?: unknown }).output;
  if (typeof output !== "object" || output === null) return null;
  const values = Object.values(output);
  if (values.length === 0) return null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = plainLine(value);
    if (text) return { kind: "text", text: text.slice(0, MAX_LENGTH) };
  }
  return { kind: "fields", count: values.length };
}
