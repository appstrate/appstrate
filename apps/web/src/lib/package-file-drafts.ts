// SPDX-License-Identifier: Apache-2.0

/**
 * The buffered half of the draft file editor: text the author has typed and
 * not yet sent.
 *
 * Structural edits (create, rename, delete, upload) each go to the server
 * immediately and the response replaces the tree, so the client never has to
 * replay tree algebra. Typing does not — a `PATCH` per keystroke would rewrite
 * the package's ZIP per keystroke — so the text of every touched file lives in
 * one `path → { text, base }` map until *Enregistrer* sends it as a single
 * batch.
 *
 * `base` is the server text the buffered `text` was composed against, and it is
 * what makes an overwrite VISIBLE. The flush sends `If-Match` with whatever
 * validator the client last received, and a structural operation that 412s
 * re-reads the index — which hands the editor a live validator built from a
 * tree a colleague has meanwhile written. Without `base`, the next
 * *Enregistrer* would then flush text composed against the OLD bytes with a
 * validator for the NEW ones, and the server would accept it: the guard the
 * route exists for, disarmed by its own recovery. Comparing `base` to what the
 * index now carries names exactly the files where that would happen; the editor
 * shows them and the author decides. Saving still writes their version — an
 * informed overwrite, never a silent one.
 *
 * The two halves meet here: an immediate rename has to carry the buffered text
 * of the file it renames, and an immediate delete has to drop it. That is why
 * these are functions on the map rather than inline `setState` updaters — they
 * are the only part of the editor a DOM-less test can reach, and they are the
 * part that can silently lose an author's work.
 *
 * Every function returns a NEW map and never mutates its input.
 */

import type { PackageFileEntry, PackageFileWriteOperation } from "./package-file-tree";

/** One file's unsent text, and the server bytes it was composed against. */
export interface DraftText {
  text: string;
  /** The file's server text at the moment the author started from it. */
  base: string;
}

/** Buffered text per path — absent means "unchanged since the server sent it". */
export type DraftTexts = Readonly<Record<string, DraftText>>;

/**
 * Record what the editor now holds for one file.
 *
 * Text equal to what the server sent is not an edit: typing a character and
 * undoing it leaves the file clean, so the entry is dropped rather than kept at
 * its original value. Without that, the unsaved-changes blocker would fire on a
 * file the author reverted, and the flush would rewrite bytes nobody changed.
 *
 * `base` is pinned on the FIRST keystroke and never refreshed while the buffer
 * lives: it answers "which bytes was this typed on top of", and re-reading it
 * from a later render would answer "which bytes are there now" — the question
 * that always says "no conflict".
 */
export function setDraftText(
  drafts: DraftTexts,
  path: string,
  text: string,
  serverText: string,
): DraftTexts {
  const next = { ...drafts };
  if (text === serverText) delete next[path];
  else next[path] = { text, base: drafts[path]?.base ?? serverText };
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
 * The paths whose server text moved under the buffer — the files *Enregistrer*
 * would overwrite someone else's work on.
 *
 * A file the index does not carry `inline` for (over the response's preview
 * budget, or binary) is reported as NOT conflicted: its server text is unknown
 * to this client, and calling every large file conflicted would cry wolf on
 * every save. The server's own `If-Match` is what still guards those — this
 * detection narrows the window the 412 recovery opens, it does not replace it.
 *
 * A path the tree no longer holds is not conflicted either: the file was
 * deleted or renamed elsewhere, the buffered text will land as a new file, and
 * there is nothing of anyone's to overwrite.
 */
export function conflictedDrafts(
  drafts: DraftTexts,
  entries: readonly PackageFileEntry[],
): ReadonlySet<string> {
  const serverText = new Map(entries.map((entry) => [entry.path, entry.inline]));
  const conflicted = new Set<string>();
  for (const [path, draft] of Object.entries(drafts)) {
    const current = serverText.get(path);
    if (current !== undefined && current !== draft.base) conflicted.add(path);
  }
  return conflicted;
}

/**
 * The whole buffer as one atomic batch. Order is irrelevant — every operation
 * is a `write` on a distinct path — so the map's own key order is used as is.
 */
export function draftWriteOperations(drafts: DraftTexts): PackageFileWriteOperation[] {
  return Object.entries(drafts).map(([path, draft]) => ({
    op: "write" as const,
    path,
    text: draft.text,
  }));
}

/** Whether anything is waiting to be sent. */
export function hasDraftTexts(drafts: DraftTexts): boolean {
  return Object.keys(drafts).length > 0;
}
