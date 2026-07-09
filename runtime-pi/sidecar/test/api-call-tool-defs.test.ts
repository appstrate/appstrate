// SPDX-License-Identifier: Apache-2.0

/**
 * `createApiCallToolDefs` — the unprefixed tool names + `_meta` marker payloads
 * the sidecar hands to the McpHost for one integration's api_call surface.
 *
 * Regression: the defs used to be forced onto the bare `api_call` /`api_upload`
 * names, dropping the `__{authKey}` suffix the spawn resolver had computed. A
 * multi-auth integration therefore registered two tools under one name and the
 * host silently disambiguated the second to `{ns}__api_call_2` — a name no
 * catalog advertises and no agent can select.
 */

import { describe, it, expect } from "bun:test";
import {
  API_CALL_TOOL_META_KEY,
  API_UPLOAD_TOOL_META_KEY,
  readApiCallToolKey,
  readApiUploadSiblingKey,
} from "@appstrate/mcp-transport";
import {
  createApiCallToolDefs,
  type ApiCallIntegrationConfig,
  type ApiCallToolDeps,
} from "../mcp.ts";

// The handlers are never invoked here — only the descriptors are inspected.
const unreachable = () => {
  throw new Error("not called");
};
const deps = { proxyDeps: { fetchFn: unreachable } } as unknown as ApiCallToolDeps;

function integ(overrides: Partial<ApiCallIntegrationConfig> = {}): ApiCallIntegrationConfig {
  return {
    namespace: "drive",
    integrationId: "@appstrate/google-drive",
    fetchCredentials: unreachable as unknown as ApiCallIntegrationConfig["fetchCredentials"],
    refreshCredentials: unreachable as unknown as ApiCallIntegrationConfig["refreshCredentials"],
    ...overrides,
  };
}

/** Names are UNPREFIXED here — `McpHost.register` applies the `{ns}__` prefix. */
function namesOf(defs: ReturnType<typeof createApiCallToolDefs>): string[] {
  return defs.map((d) => d.descriptor.name);
}

describe("createApiCallToolDefs — tool names", () => {
  it("single auth: bare api_call, no companion without upload protocols", () => {
    expect(namesOf(createApiCallToolDefs(integ(), deps))).toEqual(["api_call"]);
  });

  it("single auth with upload protocols: bare api_call + api_upload", () => {
    const defs = createApiCallToolDefs(
      integ({ toolName: "api_call", uploadProtocols: ["google-resumable"] }),
      deps,
    );
    expect(namesOf(defs)).toEqual(["api_call", "api_upload"]);
  });

  it("multi-auth: preserves the __{authKey} suffix on both tools", () => {
    const defs = createApiCallToolDefs(
      integ({ toolName: "api_call__primary", uploadProtocols: ["google-resumable"] }),
      deps,
    );
    expect(namesOf(defs)).toEqual(["api_call__primary", "api_upload__primary"]);
  });

  it("multi-auth: two auths of one integration never collide on a name", () => {
    const primary = namesOf(
      createApiCallToolDefs(
        integ({ toolName: "api_call__primary", uploadProtocols: ["tus"] }),
        deps,
      ),
    );
    const backup = namesOf(createApiCallToolDefs(integ({ toolName: "api_call__backup" }), deps));
    expect(new Set([...primary, ...backup]).size).toBe(primary.length + backup.length);
  });
});

describe("createApiCallToolDefs — _meta marker payloads", () => {
  it("stamps the auth-scoped key on api_call and points api_upload back at it", () => {
    const defs = createApiCallToolDefs(
      integ({ toolName: "api_call__primary", uploadProtocols: ["google-resumable"] }),
      deps,
    );
    const [call, upload] = defs;
    expect(readApiCallToolKey(call!.descriptor)).toBe("api_call__primary");
    expect(readApiUploadSiblingKey(upload!.descriptor)).toBe("api_call__primary");
  });

  it("the api_upload sibling key matches its own auth, not another auth's", () => {
    const backup = createApiCallToolDefs(
      integ({ toolName: "api_call__backup", uploadProtocols: ["tus"] }),
      deps,
    );
    expect(readApiUploadSiblingKey(backup[1]!.descriptor)).toBe("api_call__backup");
  });

  it("carries exactly one marker per descriptor", () => {
    const defs = createApiCallToolDefs(integ({ uploadProtocols: ["tus"] }), deps);
    // `toHaveProperty` reads a dotted string as a path — compare key sets.
    expect(Object.keys(defs[0]!.descriptor._meta ?? {})).toEqual([API_CALL_TOOL_META_KEY]);
    expect(Object.keys(defs[1]!.descriptor._meta ?? {})).toEqual([API_UPLOAD_TOOL_META_KEY]);
  });

  it("drops the upload tool when every declared protocol is an empty string", () => {
    expect(namesOf(createApiCallToolDefs(integ({ uploadProtocols: [""] }), deps))).toEqual([
      "api_call",
    ]);
  });
});
