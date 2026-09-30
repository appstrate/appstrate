// SPDX-License-Identifier: Apache-2.0

/**
 * `base` when it is not taken, else its first free ` (2)`, ` (3)`, … form — the one collision
 * rule for every label. With `maxLength`, the base is cut to fit: in UTF-16 units, on a code-point
 * boundary, trailing whitespace trimmed when cut.
 */
export function dedupeLabel(
  base: string,
  existing: Iterable<string>,
  options: { maxLength?: number } = {},
): string {
  const taken = existing instanceof Set ? existing : new Set(existing);
  const max = options.maxLength ?? Infinity;
  const withSuffix = (suffix: string) => `${truncateLabel(base, max - suffix.length)}${suffix}`;
  let candidate = withSuffix("");
  for (let n = 2; taken.has(candidate); n++) candidate = withSuffix(` (${n})`);
  return candidate;
}

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  let out = "";
  for (const ch of label) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trimEnd();
}
