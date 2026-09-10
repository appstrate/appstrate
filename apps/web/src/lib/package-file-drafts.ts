// SPDX-License-Identifier: Apache-2.0

/**
 * The buffered half of the draft file editor: text the author has typed and
 * not yet sent.
 *
 * Structural edits (create, rename, delete, upload) each go to the server
 * immediately and the response replaces the tree, so the client never has to
 * replay tree algebra. Typing does not — a `PATCH` per keystroke would rewrite
 * the package's ZIP per keystroke — so the text of every touched file lives in
 * one `path → text` map until *Enregistrer* sends it as a single batch.
 *
 * The two halves meet here: an immediate rename has to carry the buffered text
 * of the file it renames, and an immediate delete has to drop it. That is why
 * these are functions on the map rather than inline `setState` updaters — they
 * are the only part of the editor a DOM-less test can reach, and they are the
 * part that can silently lose an author's work.
 *
 * Every function returns a NEW map and never mutates its input.
 */

import type { PackageFileWriteOperation } from "./package-file-tree";

/** Buffered text per path — absent means "unchanged since the server sent it". */
export type DraftTexts = Readonly<Record<string, string>>;

/**
 * Record what the editor now holds for one file.
 *
 * Text equal to what the server sent is not an edit: typing a character and
 * undoing it leaves the file clean, so the entry is dropped rather than kept at
 * its original value. Without that, the unsaved-changes blocker would fire on a
 * file the author reverted, and the flush would rewrite bytes nobody changed.
 */
export function setDraftText(
  drafts: DraftTexts,
  path: string,
  text: string,
  serverText: string,
): DraftTexts {
  const next = { ...drafts };
  if (text === serverText) delete next[path];
  else next[path] = text;
  return next;
}

/** Forget one file's buffered text — it was deleted, or replaced wholesale. */
export function dropDraftText(drafts: DraftTexts, path: string): DraftTexts {
  if (drafts[path] === undefined) return drafts;
  const next = { ...drafts };
  delete next[path];
  return next;
}

/**
 * Follow a rename. The server moved the bytes it already had; the unsent text
 * has to move with them, or saving after a rename would write the author's
 * edits back to a path that no longer exists — and the route would answer `200`
 * for creating it.
 */
export function renameDraftText(drafts: DraftTexts, from: string, to: string): DraftTexts {
  const buffered = drafts[from];
  if (buffered === undefined) return drafts;
  const next = { ...drafts };
  next[to] = buffered;
  delete next[from];
  return next;
}

/**
 * The whole buffer as one atomic batch. Order is irrelevant — every operation
 * is a `write` on a distinct path — so the map's own key order is used as is.
 */
export function draftWriteOperations(drafts: DraftTexts): PackageFileWriteOperation[] {
  return Object.entries(drafts).map(([path, text]) => ({ op: "write" as const, path, text }));
}

/** Whether anything is waiting to be sent. */
export function hasDraftTexts(drafts: DraftTexts): boolean {
  return Object.keys(drafts).length > 0;
}
