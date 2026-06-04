// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `{ns}__api_upload` agent-side extension wiring:
 *
 *   - `isApiUploadToolName` recognises only `{ns}__api_upload` names.
 *   - `apiCallToolNameFor` maps an upload tool to its sibling api_call tool.
 *   - `buildApiUploadToolFactory` gates off (returns []) when the
 *     advertised descriptor declares no dispatchable `uploadProtocol`,
 *     and registers a Pi tool when it does.
 *   - Unknown protocol identifiers in the descriptor enum are filtered.
 */

import { describe, it, expect } from "bun:test";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import {
  isApiUploadToolName,
  apiCallToolNameFor,
  buildApiUploadToolFactory,
} from "../mcp/api-upload-extension.ts";

const fakeMcp = {} as AppstrateMcpClient;

function uploadTool(
  name: string,
  protocols: unknown,
): { name: string; description?: string; inputSchema?: unknown } {
  return {
    name,
    description: "mock upload tool",
    inputSchema: {
      type: "object",
      properties: {
        uploadProtocol: { type: "string", enum: protocols },
      },
    },
  };
}

describe("isApiUploadToolName", () => {
  it("matches `{ns}__api_upload`", () => {
    expect(isApiUploadToolName("@scope/drive__api_upload")).toBe(true);
    expect(isApiUploadToolName("gmail__api_upload")).toBe(true);
  });

  it("rejects api_call and other tools", () => {
    expect(isApiUploadToolName("gmail__api_call")).toBe(false);
    expect(isApiUploadToolName("run_history")).toBe(false);
    expect(isApiUploadToolName("recall_memory")).toBe(false);
    // The bare suffix with no namespace is not a valid tool name.
    expect(isApiUploadToolName("__api_upload")).toBe(false);
  });
});

describe("apiCallToolNameFor", () => {
  it("maps the upload tool to its sibling api_call tool", () => {
    expect(apiCallToolNameFor("gmail__api_upload")).toBe("gmail__api_call");
    expect(apiCallToolNameFor("@scope/drive__api_upload")).toBe("@scope/drive__api_call");
  });
});

describe("buildApiUploadToolFactory", () => {
  it("returns [] when the descriptor declares no dispatchable protocol", () => {
    const factories = buildApiUploadToolFactory({
      tool: uploadTool("x__api_upload", undefined),
      mcp: fakeMcp,
      runId: "r",
      workspace: "/ws",
      emit: () => {},
    });
    expect(factories).toEqual([]);
  });

  it("returns [] when the enum is empty or non-array", () => {
    expect(
      buildApiUploadToolFactory({
        tool: uploadTool("x__api_upload", []),
        mcp: fakeMcp,
        runId: "r",
        workspace: "/ws",
        emit: () => {},
      }),
    ).toEqual([]);
    expect(
      buildApiUploadToolFactory({
        tool: uploadTool("x__api_upload", "google-resumable"),
        mcp: fakeMcp,
        runId: "r",
        workspace: "/ws",
        emit: () => {},
      }),
    ).toEqual([]);
  });

  it("filters unknown protocol identifiers (defence-in-depth)", () => {
    // Only `google-resumable` is dispatchable; `made-up` is filtered. The
    // factory still registers (≥1 valid protocol remains).
    const factories = buildApiUploadToolFactory({
      tool: uploadTool("x__api_upload", ["google-resumable", "made-up"]),
      mcp: fakeMcp,
      runId: "r",
      workspace: "/ws",
      emit: () => {},
    });
    expect(factories.length).toBe(1);
  });

  it("returns [] when every declared protocol is unknown", () => {
    const factories = buildApiUploadToolFactory({
      tool: uploadTool("x__api_upload", ["nonexistent", "another-fake"]),
      mcp: fakeMcp,
      runId: "r",
      workspace: "/ws",
      emit: () => {},
    });
    expect(factories).toEqual([]);
  });

  it("registers a Pi tool named after the advertised upload tool", () => {
    const factories = buildApiUploadToolFactory({
      tool: uploadTool("@scope/drive__api_upload", ["google-resumable", "s3-multipart"]),
      mcp: fakeMcp,
      runId: "r",
      workspace: "/ws",
      emit: () => {},
    });
    expect(factories.length).toBe(1);
    // Invoke the factory against a stub ExtensionAPI to capture the
    // registered tool name.
    let registeredName: string | undefined;
    const pi = {
      registerTool: (def: { name: string }) => {
        registeredName = def.name;
      },
    } as never;
    factories[0]!(pi);
    expect(registeredName).toBe("@scope/drive__api_upload");
  });
});
