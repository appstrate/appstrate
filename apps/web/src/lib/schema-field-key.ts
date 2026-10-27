// SPDX-License-Identifier: Apache-2.0

import { toSlug } from "./strings";

/**
 * A field key as it will be saved (slugged), and the i18n key of what refuses
 * it: an empty key, or one another field of the schema already holds.
 */
export function fieldKeyVerdict(
  rawKey: string,
  takenKeys: readonly string[],
): { key: string; error: "editor.fieldKeyRequired" | "editor.fieldKeyTaken" | null } {
  const key = toSlug(rawKey);
  if (!key) return { key, error: "editor.fieldKeyRequired" };
  return { key, error: takenKeys.includes(key) ? "editor.fieldKeyTaken" : null };
}
