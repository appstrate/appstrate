// SPDX-License-Identifier: Apache-2.0

/**
 * Convert a Date to ISO string, returning null if missing.
 */
export function toISO(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}

/**
 * Convert a Date to ISO string, falling back to current time if missing.
 */
export function toISORequired(date: Date | null | undefined): string {
  return (date ?? new Date()).toISOString();
}
