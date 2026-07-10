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
  readApiCallToolKey,
  readApiUploadSiblingKey,
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

  it("detects a marker carrying a payload object, not just a boolean", () => {
    expect(isApiCallTool({ _meta: { [API_CALL_TOOL_META_KEY]: { tool_key: "api_call" } } })).toBe(
      true,
    );
    expect(
      isApiUploadTool({
        _meta: { [API_UPLOAD_TOOL_META_KEY]: { api_call_tool_key: "api_call" } },
      }),
    ).toBe(true);
  });
});

describe("readApiCallToolKey / readApiUploadSiblingKey", () => {
  it("reads the auth-scoped keys the sidecar stamped", () => {
    expect(
      readApiCallToolKey({
        _meta: { [API_CALL_TOOL_META_KEY]: { tool_key: "api_call__primary" } },
      }),
    ).toBe("api_call__primary");
    expect(
      readApiUploadSiblingKey({
        _meta: { [API_UPLOAD_TOOL_META_KEY]: { api_call_tool_key: "api_call__primary" } },
      }),
    ).toBe("api_call__primary");
  });

  it("returns undefined for a payload-less marker (older descriptor shape)", () => {
    expect(readApiCallToolKey({ _meta: { [API_CALL_TOOL_META_KEY]: true } })).toBeUndefined();
    expect(
      readApiUploadSiblingKey({ _meta: { [API_UPLOAD_TOOL_META_KEY]: true } }),
    ).toBeUndefined();
  });

  it("returns undefined for a missing, empty, or non-string field", () => {
    expect(readApiCallToolKey({})).toBeUndefined();
    expect(readApiCallToolKey({ _meta: { [API_CALL_TOOL_META_KEY]: {} } })).toBeUndefined();
    expect(
      readApiCallToolKey({ _meta: { [API_CALL_TOOL_META_KEY]: { tool_key: "" } } }),
    ).toBeUndefined();
    expect(
      readApiCallToolKey({ _meta: { [API_CALL_TOOL_META_KEY]: { tool_key: 42 } } }),
    ).toBeUndefined();
  });

  it("does not read one marker's field out of the other marker", () => {
    expect(
      readApiCallToolKey({
        _meta: { [API_UPLOAD_TOOL_META_KEY]: { api_call_tool_key: "api_call" } },
      }),
    ).toBeUndefined();
  });
});
