/**
 * Convert a Date to ISO string, returning null if missing.
 */
export function toISO(date: Date | null | undefined): string | null {
  return date?.toISOString() ?? null;
}

/**
 * Convert a Date to ISO string, returning empty string if missing.
 */
export function toISORequired(date: Date | null | undefined): string {
  return date?.toISOString() ?? "";
}
