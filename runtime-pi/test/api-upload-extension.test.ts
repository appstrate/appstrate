// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `{ns}__api_upload` agent-side extension wiring:
 *
 *   - `buildApiUploadToolFactory` gates off (returns []) when the
 *     advertised descriptor declares no dispatchable `uploadProtocol`,
 *     and registers a Pi tool when it does.
 *   - Unknown protocol identifiers in the descriptor enum are filtered.
 *
 * (Tool DETECTION moved to the `dev.appstrate/api-upload` `_meta` marker —
 * tested in `@appstrate/mcp-transport`'s `tool-meta` suite.)
 */

import { describe, it, expect } from "bun:test";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import { buildApiUploadToolFactory } from "../mcp/api-upload-extension.ts";

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

describe("buildApiUploadToolFactory", () => {
  it("returns [] when the descriptor declares no dispatchable protocol", () => {
    const factories = buildApiUploadToolFactory({
      tool: uploadTool("x__api_upload", undefined),
      apiCallToolName: "x__api_call",
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
        apiCallToolName: "x__api_call",
        mcp: fakeMcp,
        runId: "r",
        workspace: "/ws",
        emit: () => {},
      }),
    ).toEqual([]);
    expect(
      buildApiUploadToolFactory({
        tool: uploadTool("x__api_upload", "google-resumable"),
        apiCallToolName: "x__api_call",
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
      apiCallToolName: "x__api_call",
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
      apiCallToolName: "x__api_call",
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
      apiCallToolName: "x__api_call",
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
