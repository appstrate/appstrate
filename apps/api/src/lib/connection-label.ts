// SPDX-License-Identifier: Apache-2.0

/**
 * What a connection label may contain. A label reaches the model verbatim —
 * it is the `connection` enum value on every tool of a namespace bound to
 * several connections — so a member-edited one must not smuggle a line break,
 * an invisible character or a bidi override into the prompt.
 */

export const CONNECTION_LABEL_MAX = 80;

/** Characters that render as a line break, and so become a plain space when minting. */
function isLineOrTab(cp: number): boolean {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

/** C0/C1 controls, soft hyphen, zero-width and bidi controls, BOM. */
function isForbidden(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** Why `label` cannot be stored as a connection label, or null when it can. */
export function connectionLabelProblem(label: string): string | null {
  if (label.trim() === "") return "must not be empty";
  if (label.length > CONNECTION_LABEL_MAX) {
    return `must be at most ${CONNECTION_LABEL_MAX} characters`;
  }
  for (const ch of label) {
    if (isForbidden(ch.codePointAt(0)!)) {
      return "must not contain control, invisible or bidirectional-override characters";
    }
  }
  return null;
}

/**
 * A label minted from a provider identity (email, login…), made storable:
 * line breaks become spaces, the other forbidden characters go, whitespace
 * collapses, and the result is cut to {@link CONNECTION_LABEL_MAX}. May be
 * empty — the caller then mints "Connexion N" instead.
 */
export function toMintedLabel(raw: string): string {
  let cleaned = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (isLineOrTab(cp)) cleaned += " ";
    else if (!isForbidden(cp)) cleaned += ch;
  }
  let out = "";
  for (const ch of cleaned.replace(/\s+/g, " ").trim()) {
    if (out.length + ch.length > CONNECTION_LABEL_MAX) break;
    out += ch;
  }
  return out.trimEnd();
}
