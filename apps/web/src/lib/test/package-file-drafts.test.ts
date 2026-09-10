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
  draftWriteOperations,
  dropDraftText,
  hasDraftTexts,
  renameDraftText,
  setDraftText,
  type DraftTexts,
} from "../package-file-drafts.ts";

describe("setDraftText", () => {
  it("records text that differs from what the server sent", () => {
    expect(setDraftText({}, "SKILL.md", "edited", "original")).toEqual({ "SKILL.md": "edited" });
  });

  it("DROPS the entry when the author lands back on the server's text", () => {
    // Typing a character and undoing it is not an unsaved change: keeping the
    // entry would fire the navigation blocker and rewrite untouched bytes.
    const drafts = setDraftText({ "SKILL.md": "edited" }, "SKILL.md", "original", "original");
    expect(drafts).toEqual({});
  });

  it("leaves the other buffered files alone", () => {
    const before: DraftTexts = { "a.md": "A" };
    expect(setDraftText(before, "b.md", "B", "")).toEqual({ "a.md": "A", "b.md": "B" });
    expect(before).toEqual({ "a.md": "A" });
  });

  it("treats the empty string as a real edit of a non-empty file", () => {
    expect(setDraftText({}, "a.md", "", "was here")).toEqual({ "a.md": "" });
  });
});

describe("dropDraftText", () => {
  it("forgets the buffered text of a deleted file", () => {
    expect(dropDraftText({ "a.md": "A", "b.md": "B" }, "a.md")).toEqual({ "b.md": "B" });
  });

  it("returns the same map when there was nothing buffered", () => {
    const before: DraftTexts = { "a.md": "A" };
    expect(dropDraftText(before, "b.md")).toBe(before);
  });

  it("does not mutate its input", () => {
    const before: DraftTexts = { "a.md": "A" };
    dropDraftText(before, "a.md");
    expect(before).toEqual({ "a.md": "A" });
  });
});

describe("renameDraftText", () => {
  it("carries unsent text to the new path", () => {
    // Without this the next save would write the author's edits back to a path
    // the rename emptied, and the route would answer 200 for CREATING it.
    expect(renameDraftText({ "old.md": "typed" }, "old.md", "new.md")).toEqual({
      "new.md": "typed",
    });
  });

  it("returns the same map when the renamed file had nothing buffered", () => {
    const before: DraftTexts = { "other.md": "O" };
    expect(renameDraftText(before, "old.md", "new.md")).toBe(before);
  });

  it("keeps a buffered empty string, which is not the same as no buffer", () => {
    expect(renameDraftText({ "old.md": "" }, "old.md", "new.md")).toEqual({ "new.md": "" });
  });
});

describe("draftWriteOperations", () => {
  it("turns the buffer into one write operation per path", () => {
    expect(draftWriteOperations({ "SKILL.md": "body", "docs/a.md": "notes" })).toEqual([
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
    expect(hasDraftTexts({ "a.md": "" })).toBe(true);
  });
});
