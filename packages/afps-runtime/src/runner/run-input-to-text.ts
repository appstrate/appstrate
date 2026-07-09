// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared normalisation of an {@link ExecutionContext.input} (`z.unknown()`)
 * into prompt text.
 *
 * A runner that folds the run input into a start message / prompt needs a
 * three-case normalisation: a `string` is trimmed, `null`/`undefined`
 * collapses to the empty string, and any other value is `JSON.stringify`d
 * (returning `""` when the value is not serialisable — e.g. a circular
 * reference). Centralising it here keeps the shape stable.
 *
 * This helper deliberately returns `""` for the empty case — it does NOT
 * append a fallback sentence. The runner keeps its own fallback string
 * (and persona folding) on top, so the human-facing "begin the task"
 * wording stays owned by the runner.
 */
export function runInputToText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (input == null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}
