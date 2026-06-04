/**
 * Dedupe a label against a set of existing labels. Returns `base` when it is
 * not already taken, otherwise appends ` (2)`, ` (3)`, … until a free name is
 * found. Pure helper shared between the frontend credential UI and the
 * server-side credential/model label derivation so the collision rule lives in
 * one place.
 */
export function dedupeLabel(base: string, existing: Iterable<string>): string {
  const taken = existing instanceof Set ? existing : new Set(existing);
  if (!taken.has(base)) return base;
  let counter = 2;
  while (taken.has(`${base} (${counter})`)) counter++;
  return `${base} (${counter})`;
}
