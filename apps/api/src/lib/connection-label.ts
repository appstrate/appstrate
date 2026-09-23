// SPDX-License-Identifier: Apache-2.0

// A label reaches the model verbatim (the tools' `connection` enum), so it
// carries no line break, control, invisible or bidi character.

import { isHiddenCodePoint } from "@appstrate/mcp-transport";

export const CONNECTION_LABEL_MAX = 80;

/** Characters that render as a line break, and so become a plain space when minting. */
function isLineOrTab(cp: number): boolean {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

function isForbidden(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    isHiddenCodePoint(cp)
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

/** A provider identity made storable, cut to the max; empty → the caller mints "Connexion N". */
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
