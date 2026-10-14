// SPDX-License-Identifier: Apache-2.0

/**
 * A save settles on the state it SENT: what the author typed while it was in
 * flight is neither overwritten nor read as saved.
 */

import { describe, expect, it } from "bun:test";
import type { PackageFileWriteOperation } from "../../lib/package-file-tree.ts";
import { settleSavedState, type EditorState } from "../use-editor-state.ts";

const remove = (path: string): PackageFileWriteOperation => ({ op: "delete", path });

describe("settleSavedState", () => {
  it("keeps edits made after the save was sent, under the new ETag", () => {
    const sent: EditorState = { manifest: { description: "a" }, etag: "v1" };
    const current: EditorState = { manifest: { description: "ab" }, etag: "v1" };
    expect(settleSavedState(current, sent, "v2")).toEqual({
      manifest: { description: "ab" },
      etag: "v2",
      operations: undefined,
    });
  });

  it("drops the file operations the save carried and keeps the ones staged after", () => {
    const saved = remove("a.md");
    const later = remove("b.md");
    const sent: EditorState = { manifest: {}, etag: "v1", operations: [saved] };
    const current: EditorState = { manifest: {}, etag: "v1", operations: [saved, later] };
    expect(settleSavedState(current, sent, "v2").operations).toEqual([later]);
    expect(settleSavedState(sent, sent, "v2").operations).toBeUndefined();
  });

  it("leaves the editor dirty when it moved on during the save", () => {
    const sent: EditorState = { manifest: { description: "a" }, etag: "v1" };
    const current: EditorState = { manifest: { description: "ab" }, etag: "v1" };
    const snapshot = settleSavedState(sent, sent, "v2");
    const state = settleSavedState(current, sent, "v2");
    expect(JSON.stringify(state)).not.toBe(JSON.stringify(snapshot));
  });
});
