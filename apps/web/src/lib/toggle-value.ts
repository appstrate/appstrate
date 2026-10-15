// SPDX-License-Identifier: Apache-2.0

/**
 * Ticking a value adds it, unticking removes it. Nothing is collapsed: ticking every value
 * leaves them all ticked rather than resetting to none.
 */
export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
