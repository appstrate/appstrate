// SPDX-License-Identifier: Apache-2.0

/**
 * The buffered half of the draft file editor.
 *
 * This is the whole of what the editor computes on its own — everything else it
 * does is "send these operations and adopt the tree that comes back" — and it
 * is the half that can lose an author's unsent work, so it is pinned here
 * rather than left to a rendered test the DOM-less runner cannot perform.
 */

import { describe, it, expect } from "bun:test";
import {
  conflictedDrafts,
  draftWriteOperations,
  dropDraftText,
  hasDraftTexts,
  renameDraftText,
  setDraftText,
  type DraftTexts,
} from "../package-file-drafts.ts";
import type { PackageFileEntry } from "../package-file-tree.ts";

/** One buffered edit: `text` typed on top of `base`. */
const draft = (text: string, base = "original") => ({ text, base });

/** An index entry carrying its full text, as the route inlines it. */
const entry = (path: string, inline: string | undefined): PackageFileEntry => ({
  path,
  size: inline?.length ?? 0,
  media_kind: "text",
  ...(inline === undefined ? {} : { inline }),
});

describe("setDraftText", () => {
  it("records text that differs from what the server sent, with the bytes it was typed on", () => {
    expect(setDraftText({}, "SKILL.md", "edited", "original")).toEqual({
      "SKILL.md": { text: "edited", base: "original" },
    });
  });

  it("pins `base` on the FIRST keystroke and keeps it through every later one", () => {
    // `base` answers "which bytes was this typed on top of". Refreshing it on
    // each keystroke would answer "which bytes are there now" — which is always
    // the current ones, so no overwrite could ever be detected.
    const first = setDraftText({}, "SKILL.md", "e", "original");
    const second = setDraftText(first, "SKILL.md", "ed", "original");
    expect(second["SKILL.md"]).toEqual({ text: "ed", base: "original" });
  });

  it("DROPS the entry when the author lands back on the server's text", () => {
    // Typing a character and undoing it is not an unsaved change: keeping the
    // entry would fire the navigation blocker and rewrite untouched bytes.
    const drafts = setDraftText(
      { "SKILL.md": draft("edited") },
      "SKILL.md",
      "original",
      "original",
    );
    expect(drafts).toEqual({});
  });

  it("leaves the other buffered files alone", () => {
    const before: DraftTexts = { "a.md": draft("A") };
    expect(setDraftText(before, "b.md", "B", "")).toEqual({
      "a.md": draft("A"),
      "b.md": { text: "B", base: "" },
    });
    expect(before).toEqual({ "a.md": draft("A") });
  });

  it("treats the empty string as a real edit of a non-empty file", () => {
    expect(setDraftText({}, "a.md", "", "was here")).toEqual({
      "a.md": { text: "", base: "was here" },
    });
  });
});

describe("dropDraftText", () => {
  it("forgets the buffered text of a deleted file", () => {
    expect(dropDraftText({ "a.md": draft("A"), "b.md": draft("B") }, "a.md")).toEqual({
      "b.md": draft("B"),
    });
  });

  it("returns the same map when there was nothing buffered", () => {
    const before: DraftTexts = { "a.md": draft("A") };
    expect(dropDraftText(before, "b.md")).toBe(before);
  });

  it("does not mutate its input", () => {
    const before: DraftTexts = { "a.md": draft("A") };
    dropDraftText(before, "a.md");
    expect(before).toEqual({ "a.md": draft("A") });
  });
});

describe("renameDraftText", () => {
  it("carries unsent text to the new path", () => {
    // Without this the next save would write the author's edits back to a path
    // the rename emptied, and the route would answer 200 for CREATING it.
    expect(renameDraftText({ "old.md": draft("typed") }, "old.md", "new.md")).toEqual({
      "new.md": draft("typed"),
    });
  });

  it("returns the same map when the renamed file had nothing buffered", () => {
    const before: DraftTexts = { "other.md": draft("O") };
    expect(renameDraftText(before, "old.md", "new.md")).toBe(before);
  });

  it("keeps a buffered empty string, which is not the same as no buffer", () => {
    expect(renameDraftText({ "old.md": draft("") }, "old.md", "new.md")).toEqual({
      "new.md": draft(""),
    });
  });
});

describe("draftWriteOperations", () => {
  it("turns the buffer into one write operation per path", () => {
    expect(
      draftWriteOperations({ "SKILL.md": draft("body"), "docs/a.md": draft("notes") }),
    ).toEqual([
      { op: "write", path: "SKILL.md", text: "body" },
      { op: "write", path: "docs/a.md", text: "notes" },
    ]);
  });

  it("emits nothing for an empty buffer — the flush then sends no request", () => {
    expect(draftWriteOperations({})).toEqual([]);
  });
});

describe("hasDraftTexts", () => {
  it("reports whether the editor holds anything unsaved", () => {
    expect(hasDraftTexts({})).toBe(false);
    expect(hasDraftTexts({ "a.md": draft("") })).toBe(true);
  });
});

describe("conflictedDrafts", () => {
  it("names a file whose server text moved under the buffer", () => {
    // The scenario the 412 recovery opens: the author typed on E1, a colleague
    // wrote E2, the reload adopted E2's validator. Saving now overwrites them.
    const drafts: DraftTexts = { "SKILL.md": draft("mine", "theirs-before") };
    expect([...conflictedDrafts(drafts, [entry("SKILL.md", "theirs-after")])]).toEqual([
      "SKILL.md",
    ]);
  });

  it("says nothing about a file nobody else touched", () => {
    const drafts: DraftTexts = { "SKILL.md": draft("mine", "original") };
    expect(conflictedDrafts(drafts, [entry("SKILL.md", "original")]).size).toBe(0);
  });

  it("treats an unknown server text as NOT conflicted", () => {
    // A file the index carries no `inline` for — past the preview budget, or
    // binary. Calling every large file conflicted would cry wolf on every save;
    // the route's own `If-Match` still guards those.
    const drafts: DraftTexts = { "big.md": draft("mine", "original") };
    expect(conflictedDrafts(drafts, [entry("big.md", undefined)]).size).toBe(0);
  });

  it("says nothing about a path the tree no longer holds", () => {
    // Deleted or renamed elsewhere: the buffered text lands as a new file, and
    // there is nothing of anyone's to overwrite.
    const drafts: DraftTexts = { "gone.md": draft("mine", "original") };
    expect(conflictedDrafts(drafts, [entry("other.md", "x")]).size).toBe(0);
  });

  it("reports nothing when nothing is buffered", () => {
    expect(conflictedDrafts({}, [entry("SKILL.md", "anything")]).size).toBe(0);
  });
});
