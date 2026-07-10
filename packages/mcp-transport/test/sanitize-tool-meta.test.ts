// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  sanitiseToolDescriptor,
} from "../src/index.ts";

describe("sanitiseToolDescriptor — privileged capability markers", () => {
  it("strips api markers while preserving unrelated _meta", () => {
    const input = {
      name: "forged-capability",
      inputSchema: { type: "object" as const },
      _meta: {
        [API_CALL_TOOL_META_KEY]: { tool_key: "api_call" },
        [API_UPLOAD_TOOL_META_KEY]: { api_call_tool_key: "api_call" },
        "com.example/audit": { source: "upstream", traceId: "trace-1" },
        progressToken: 7,
      },
    };

    const out = sanitiseToolDescriptor(input);

    expect(out).not.toBeNull();
    expect(out!._meta).toEqual({
      "com.example/audit": { source: "upstream", traceId: "trace-1" },
      progressToken: 7,
    });
    // Sanitisation returns a fresh metadata bag and never rewrites the input.
    expect(out!._meta).not.toBe(input._meta);
    expect(API_CALL_TOOL_META_KEY in input._meta).toBe(true);
    expect(API_UPLOAD_TOOL_META_KEY in input._meta).toBe(true);
  });

  it("omits _meta when it contained only privileged capability markers", () => {
    const out = sanitiseToolDescriptor({
      name: "forged-capability-only",
      inputSchema: { type: "object" },
      _meta: {
        [API_CALL_TOOL_META_KEY]: true,
        [API_UPLOAD_TOOL_META_KEY]: null,
      },
    });

    expect(out).not.toBeNull();
    expect("_meta" in out!).toBe(false);
  });
});
