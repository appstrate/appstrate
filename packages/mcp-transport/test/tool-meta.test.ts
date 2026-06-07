// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tool-descriptor `_meta` capability markers — the
 * explicit, rename-safe replacement for matching the `{ns}__api_call` /
 * `{ns}__api_upload` tool name. The readers key off `_meta` ALONE, never
 * the tool name (the literals below carry no name on purpose).
 */

import { describe, it, expect } from "bun:test";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  readApiCallToolMeta,
  readApiUploadToolMeta,
} from "../src/tool-meta.ts";

describe("readApiCallToolMeta", () => {
  it("reads the api_call marker", () => {
    const tool = { _meta: { [API_CALL_TOOL_META_KEY]: { body_from_file: true } } };
    expect(readApiCallToolMeta(tool)).toEqual({ body_from_file: true });
  });

  it("returns null when the marker is absent", () => {
    expect(readApiCallToolMeta({})).toBeNull();
    expect(readApiCallToolMeta({ _meta: {} })).toBeNull();
    expect(readApiCallToolMeta({ _meta: { "other/key": {} } })).toBeNull();
  });

  it("does not confuse the api_upload marker for api_call", () => {
    const tool = { _meta: { [API_UPLOAD_TOOL_META_KEY]: { protocols: [] } } };
    expect(readApiCallToolMeta(tool)).toBeNull();
  });
});

describe("readApiUploadToolMeta", () => {
  it("reads the api_upload marker and normalises protocols", () => {
    const tool = { _meta: { [API_UPLOAD_TOOL_META_KEY]: { protocols: ["s3-multipart", "tus"] } } };
    expect(readApiUploadToolMeta(tool)).toEqual({ protocols: ["s3-multipart", "tus"] });
  });

  it("coerces a missing/garbage protocols field to an empty array", () => {
    expect(readApiUploadToolMeta({ _meta: { [API_UPLOAD_TOOL_META_KEY]: {} } })).toEqual({
      protocols: [],
    });
    expect(
      readApiUploadToolMeta({
        _meta: { [API_UPLOAD_TOOL_META_KEY]: { protocols: [1, "ok", null] } },
      }),
    ).toEqual({ protocols: ["ok"] });
  });

  it("returns null when the marker is absent", () => {
    expect(readApiUploadToolMeta({})).toBeNull();
    expect(readApiUploadToolMeta({ _meta: {} })).toBeNull();
  });
});
