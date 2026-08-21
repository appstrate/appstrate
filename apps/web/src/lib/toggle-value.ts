// SPDX-License-Identifier: Apache-2.0

/**
 * Ticking a value adds it, unticking removes it. That is the whole rule.
 *
 * Its own module so a test can hold it, because it was got wrong once: a
 * version that ALSO collapsed "every value ticked" to "nothing ticked" was true
 * of the results and nonsense as an interaction — a two-value dimension had its
 * first tick silently undone by its second, and a one-value dimension could
 * never stay ticked at all.
 */
export function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}
