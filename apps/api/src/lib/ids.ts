/** Generate a prefixed UUID (e.g. "wh_abc-123", "app_def-456"). */
export function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
