// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared normalisation of an {@link ExecutionContext.input} (`z.unknown()`)
 * into prompt text.
 *
 * Every runner that folds the run input into a start message / prompt
 * (`runner-claude`, `runner-codex`) independently spelled out the same
 * three-case normalisation: a `string` is trimmed, `null`/`undefined`
 * collapses to the empty string, and any other value is `JSON.stringify`d
 * (returning `""` when the value is not serialisable — e.g. a circular
 * reference). Centralising it here means the shape cannot drift between
 * runners.
 *
 * This helper deliberately returns `""` for the empty case — it does NOT
 * append a fallback sentence. Each runner keeps its own fallback string
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
