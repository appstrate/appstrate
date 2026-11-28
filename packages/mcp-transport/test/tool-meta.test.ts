// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tool-descriptor `_meta` capability predicates — the
 * explicit, rename-safe replacement for matching the `{ns}__api_call` /
 * `{ns}__api_upload` tool name. Detection is by marker presence, never the
 * tool name (the literals below carry no name on purpose).
 */

import { describe, it, expect } from "bun:test";
import {
  AGENT_PROMPT_META_KEY,
  readAgentPromptIntegration,
  readAgentPromptMeta,
} from "../src/agent-prompt-meta.ts";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  isApiCallTool,
  isApiUploadTool,
  readApiCallToolKey,
  readApiUploadSiblingKey,
  readToolIntegration,
  TOOL_INTEGRATION_META_KEY,
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

describe("readToolIntegration", () => {
  it("reads the integration tool a descriptor exposes, its title when present", () => {
    expect(
      readToolIntegration({
        _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "@acme/gh", tool: "list_issues" } },
      }),
    ).toEqual({ id: "@acme/gh", tool: "list_issues" });
    expect(
      readToolIntegration({
        _meta: {
          [TOOL_INTEGRATION_META_KEY]: { id: "@acme/gh", tool: "list_issues", title: "Issues" },
        },
      }),
    ).toEqual({ id: "@acme/gh", tool: "list_issues", title: "Issues" });
  });

  it("is undefined without a complete identity", () => {
    expect(readToolIntegration({})).toBeUndefined();
    expect(
      readToolIntegration({ _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "@acme/gh" } } }),
    ).toBeUndefined();
    expect(
      readToolIntegration({ _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "", tool: "x" } } }),
    ).toBeUndefined();
    expect(
      readToolIntegration({ _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "@acme/gh", tool: "" } } }),
    ).toBeUndefined();
    expect(
      readToolIntegration({
        _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "@acme/gh", tool: "x", title: "" } },
      }),
    ).toEqual({ id: "@acme/gh", tool: "x" });
    expect(readToolIntegration({ _meta: { [TOOL_INTEGRATION_META_KEY]: "x" } })).toBeUndefined();
  });
});

describe("readAgentPromptMeta", () => {
  const key = AGENT_PROMPT_META_KEY;
  it("reads a well-formed payload", () => {
    const integrations = [{ id: "@acme/gmail", name: "Gmail", icon: null }];
    expect(
      readAgentPromptMeta({
        [key]: {
          packageId: "@a/b",
          spaceId: "spc_a",
          icon: "lucide:bot",
          color: null,
          integrations,
        },
      }),
    ).toEqual({
      packageId: "@a/b",
      spaceId: "spc_a",
      icon: "lucide:bot",
      color: null,
      integrations,
    });
  });
  it("is null when missing or malformed", () => {
    const base = { packageId: "@a/b", spaceId: "spc_a", icon: null, color: null, integrations: [] };
    expect(readAgentPromptMeta(undefined)).toBeNull();
    expect(readAgentPromptMeta({})).toBeNull();
    expect(readAgentPromptMeta({ [key]: { ...base, packageId: "" } })).toBeNull();
    expect(readAgentPromptMeta({ [key]: { ...base, spaceId: "" } })).toBeNull();
    expect(readAgentPromptMeta({ [key]: { ...base, spaceId: undefined } })).toBeNull();
    expect(readAgentPromptMeta({ [key]: { ...base, icon: 1 } })).toBeNull();
    expect(
      readAgentPromptMeta({
        [key]: { packageId: "@a/b", spaceId: "spc_a", icon: null, integrations: [] },
      }),
    ).toBeNull();
    expect(readAgentPromptMeta({ [key]: { ...base, integrations: undefined } })).toBeNull();
  });
  it("drops a malformed integration entry alone, an empty id included, keeping the agent", () => {
    const gmail = { id: "@acme/gmail", name: "Gmail", icon: null };
    const read = readAgentPromptMeta({
      [key]: {
        packageId: "@a/b",
        spaceId: "spc_a",
        icon: null,
        color: null,
        integrations: [
          gmail,
          { id: "@acme/x", icon: null },
          { id: "", name: "Ghost", icon: null },
          { id: "@acme/y", name: "Y", icon: 3 },
          null,
        ],
      },
    });
    expect(read?.integrations).toEqual([gmail]);
  });
});

describe("readAgentPromptIntegration", () => {
  it("reads an entry, and refuses an empty id, a missing name or a non-string icon", () => {
    expect(readAgentPromptIntegration({ id: "@a/x", name: "X", icon: "logos:x" })).toEqual({
      id: "@a/x",
      name: "X",
      icon: "logos:x",
    });
    expect(readAgentPromptIntegration({ id: "", name: "X", icon: null })).toBeNull();
    expect(readAgentPromptIntegration({ id: "@a/x", icon: null })).toBeNull();
    expect(readAgentPromptIntegration({ id: "@a/x", name: "X", icon: 1 })).toBeNull();
  });
});
