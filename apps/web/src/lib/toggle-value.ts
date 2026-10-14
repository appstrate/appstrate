// SPDX-License-Identifier: Apache-2.0

/**
 * Ticking a value adds it, unticking removes it. That is the whole rule.
 *
 * "Every value ticked" is NOT collapsed to "nothing ticked": the two filter the
 * same results, but a two-value dimension would have its first tick undone by
 * its second, and a one-value dimension could never stay ticked at all.
 */
export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
