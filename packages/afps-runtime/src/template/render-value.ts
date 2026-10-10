// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Convert an interpolated value to prompt text. Strings pass through
 * unchanged; everything else is JSON-encoded so a model can read the value
 * back unambiguously (`String({})` yields `[object Object]`, and
 * `String(["a,b"])` is indistinguishable from `["a", "b"]`). Numbers,
 * booleans and `null` render exactly as `String()` would.
 */
export function renderValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
