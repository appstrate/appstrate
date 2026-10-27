// SPDX-License-Identifier: Apache-2.0

/**
 * Commits an inline rename. `unchanged` (a blank or identical trimmed draft) saves
 * nothing; `failed` tells the field to stay open on its draft, the caller owning the message.
 */
export async function commitRename(
  draft: string,
  value: string,
  save: (next: string) => void | Promise<void>,
): Promise<"unchanged" | "saved" | "failed"> {
  const next = draft.trim();
  if (!next || next === value) return "unchanged";
  try {
    await save(next);
    return "saved";
  } catch {
    return "failed";
  }
}
