// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tool-descriptor `_meta` capability predicates — the
 * explicit, rename-safe replacement for matching the `{ns}__api_call` /
 * `{ns}__api_upload` tool name. Detection is by marker presence, never the
 * tool name (the literals below carry no name on purpose).
 */

import { describe, it, expect } from "bun:test";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  isApiCallTool,
  isApiUploadTool,
} from "../src/tool-meta.ts";

describe("isApiCallTool / isApiUploadTool", () => {
  it("is true when the matching marker is present", () => {
    expect(isApiCallTool({ _meta: { [API_CALL_TOOL_META_KEY]: true } })).toBe(true);
    expect(isApiUploadTool({ _meta: { [API_UPLOAD_TOOL_META_KEY]: true } })).toBe(true);
  });

  it("is false when the marker is absent, empty, or a different key", () => {
    expect(isApiCallTool({})).toBe(false);
    expect(isApiCallTool({ _meta: {} })).toBe(false);
    expect(isApiCallTool({ _meta: { "other/key": true } })).toBe(false);
    expect(isApiUploadTool({})).toBe(false);
  });

  it("does not confuse the two markers", () => {
    expect(isApiCallTool({ _meta: { [API_UPLOAD_TOOL_META_KEY]: true } })).toBe(false);
    expect(isApiUploadTool({ _meta: { [API_CALL_TOOL_META_KEY]: true } })).toBe(false);
  });
});
