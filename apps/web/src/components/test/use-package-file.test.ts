// SPDX-License-Identifier: Apache-2.0

/**
 * The empty-file normalisation of the package file explorer (#1118).
 *
 * The route sets `Content-Length: String(bytes.byteLength)`, so `"0"` for a
 * zero-byte file, and openapi-fetch returns `{ data: undefined }` for that
 * response BEFORE `parseAs` is honoured — on a fully successful 200. Reading
 * `data` alone therefore cannot tell "this file is empty" from "no result yet",
 * and `file-preview` renders `<LoadingState/>` for `text === undefined`: an
 * infinite spinner on every empty file in an artifact.
 *
 * `packageFileText` is the decision, extracted so it can be tested as a
 * function. apps/web has no DOM harness and the hook needs a React Query
 * provider to run at all, so asserting on the pure input→output pair is the
 * honest seam — the alternative would be a render harness that exists only for
 * this one branch.
 */

import { describe, it, expect } from "bun:test";
import { packageFileText } from "../package-files/use-package-file";

describe("packageFileText", () => {
  it("returns the body of a successful fetch", () => {
    expect(packageFileText({ isSuccess: true, data: "name: skill\n" })).toBe("name: skill\n");
  });

  it("returns an empty string when a successful fetch carried no body", () => {
    // The defect: `Content-Length: "0"` makes openapi-fetch resolve with
    // `data: undefined` on a 200. Empty is a value, not a missing result.
    expect(packageFileText({ isSuccess: true, data: undefined })).toBe("");
  });

  it("does not mistake a pending, disabled or failed query for an empty file", () => {
    // The correctness constraint on the fix. `data` is `undefined` in all three
    // of those states as well, so a bare `data ?? ""` would paint an empty
    // editor over a request still in flight, over one that never ran (a
    // disabled query stays pending forever), and over an outright failure.
    // One assertion because they are one input: not-success, no data.
    expect(packageFileText({ isSuccess: false, data: undefined })).toBeUndefined();
  });

  it("treats any non-string success body as empty", () => {
    // The spec types the body as a Blob (the route declares
    // `application/octet-stream`), so the type system cannot rule this out;
    // only `parseAs: "text"` and the empty-body branch are reachable in
    // practice, and both are covered above. Pinned so the fallback can never
    // silently become a stringified object in the editor.
    expect(packageFileText({ isSuccess: true, data: null })).toBe("");
    expect(packageFileText({ isSuccess: true, data: new Blob([]) })).toBe("");
  });
});
