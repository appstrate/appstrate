// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  apiCallToolNameForAuth,
  apiToolAuthToken,
  apiUploadToolNameFor,
} from "../src/api-tool-naming.ts";
import {
  allocateMcpToolNamespace,
  MCP_TOOL_NAME_MAX_LENGTH,
  normaliseMcpToolBody,
  normaliseMcpToolNamespace,
} from "../src/mcp-naming.ts";

describe("api tool naming", () => {
  it("preserves short auth keys verbatim", () => {
    expect(apiCallToolNameForAuth("primary", true)).toBe("api_call__primary");
    expect(apiUploadToolNameFor("api_call__primary")).toBe("api_upload__primary");
  });

  it("compacts long auth keys deterministically into a disjoint 18-char token", () => {
    const key = "authentication_key_that_is_valid_but_long";
    const token = apiToolAuthToken(key);
    expect(token).toMatch(/^h0[0-9a-f]{16}$/);
    expect(token).toBe("h0a0593260c3968fd8");
    expect(token).toHaveLength(18);
    expect(apiToolAuthToken(key)).toBe(token);
    expect(apiToolAuthToken(`${key}_different`)).not.toBe(token);
  });

  it("keeps the raw and hashed token domains disjoint at the boundary", () => {
    const raw = "a".repeat(17);
    const compacted = apiToolAuthToken("a".repeat(18));
    expect(apiToolAuthToken(raw)).toBe(raw);
    expect(compacted).toMatch(/^h0[0-9a-f]{16}$/);
    expect(compacted).toHaveLength(18);
  });

  it("keeps api_upload valid at the worst McpHost namespace collision budget", () => {
    const namespace = `${"n".repeat(20)}_999`;
    const call = apiCallToolNameForAuth("authentication_key_that_is_valid_but_long", true);
    const upload = apiUploadToolNameFor(call);
    expect(`${namespace}__${upload}`).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH);
  });

  it("normalises namespaces exactly once and caps the pre-collision base", () => {
    expect(normaliseMcpToolNamespace("@Appstrate/google-drive-with-a-long-name")).toBe(
      "appstrate_google_dri",
    );
  });

  it("normalises upstream tool bodies and strips an existing namespace", () => {
    expect(normaliseMcpToolBody("api-call")).toBe("api_call");
    expect(normaliseMcpToolBody("drive__api.upload")).toBe("api_upload");
  });

  it("allocates namespace collisions with the McpHost suffix contract", () => {
    const used = new Set(["drive", "drive_2"]);
    expect(allocateMcpToolNamespace("drive", used)).toBe("drive_3");
    expect(allocateMcpToolNamespace("slack", used)).toBe("slack");
  });
});
