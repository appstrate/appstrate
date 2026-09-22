// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-error contract against the REAL Pi agent loop (issue #1490).
 *
 * Pi ignores an `isError` returned from `execute`, so an adapter's output
 * alone proves nothing. These tests register the tool through the production
 * factory, run one turn of a real `createAgentSession` on Pi's faux provider,
 * and read the verdict where it is consumed: `tool_execution_end` (what
 * `pi-runner` logs as `Tool error` / `Tool result`) and the tool-result
 * message the provider receives on the next request.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { loadPiCodingAgentSdk, type ExtensionFactory } from "../src/pi-sdk.ts";
import { buildRuntimeToolFactories } from "../src/runtime-tools/mcp-forward.ts";
import { piToolResultOrThrow } from "../src/pi-tool-result.ts";

const TOOL = "probe";

/** An MCP client whose only capability is answering `tools/call` with `result`. */
function mcpAnswering(result: CallToolResult): AppstrateMcpClient {
  return { callTool: async () => result } as unknown as AppstrateMcpClient;
}

interface ToolVerdict {
  /** `tool_execution_end.isError`. */
  isError: boolean;
  /** Text Pi recorded as the tool result. */
  text: string;
  /** `isError` on the tool-result message sent to the provider. */
  providerIsError: boolean | undefined;
}

/**
 * Run one real Pi turn in which the model calls {@link TOOL} once, and return
 * what Pi reported for that call.
 */
async function runToolCallThroughPi(result: CallToolResult): Promise<ToolVerdict> {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-error-"));
  try {
    const faux = fauxProvider();
    let providerIsError: boolean | undefined;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(TOOL, {}), { stopReason: "toolUse" }),
      (context) => {
        const toolResult = context.messages.findLast((m) => m.role === "toolResult");
        providerIsError = toolResult?.role === "toolResult" ? toolResult.isError : undefined;
        return fauxAssistantMessage(fauxText("done"));
      },
    ]);
    const toolFactories = buildRuntimeToolFactories({
      mcp: mcpAnswering(result),
      runId: "run_test",
      emit: () => {},
      tools: [{ id: TOOL, name: TOOL, description: "probe tool", parameters: { type: "object" } }],
    });
    const providerFactory: ExtensionFactory = (pi) => pi.registerProvider(faux.provider);

    const {
      createAgentSession,
      DefaultResourceLoader,
      ModelRuntime,
      SessionManager,
      SettingsManager,
    } = await loadPiCodingAgentSdk();
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory(),
      extensionFactories: [providerFactory, ...toolFactories],
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "You are a test agent.",
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: faux.getModel(),
      modelRuntime: await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      }),
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    });

    const ends: Array<Omit<ToolVerdict, "providerIsError">> = [];
    session.subscribe((event) => {
      if (event.type !== "tool_execution_end") return;
      const blocks = (event.result as { content?: Array<{ type: string; text?: string }> }).content;
      ends.push({
        isError: event.isError,
        text: (blocks ?? []).map((b) => b.text ?? "").join(""),
      });
    });
    try {
      await session.prompt("call the probe");
    } finally {
      session.dispose();
    }

    expect(ends).toHaveLength(1);
    return { ...ends[0]!, providerIsError };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MCP tool results through the real Pi loop", () => {
  it("records an MCP `isError: true` result as a tool error, keeping its text", async () => {
    const end = await runToolCallThroughPi({
      content: [{ type: "text", text: '{ "error": "sftp failed (exit 1)" }' }],
      isError: true,
    });

    expect(end.isError).toBe(true);
    expect(end.providerIsError).toBe(true);
    expect(end.text).toBe('{ "error": "sftp failed (exit 1)" }');
  });

  it("records a normal MCP result as a success", async () => {
    const end = await runToolCallThroughPi({ content: [{ type: "text", text: "ok" }] });

    expect(end.isError).toBe(false);
    expect(end.providerIsError).toBe(false);
    expect(end.text).toBe("ok");
  });
});

describe("piToolResultOrThrow", () => {
  it("returns content and details on success", () => {
    expect(
      piToolResultOrThrow({ content: [{ type: "text", text: "ok" }], details: { n: 1 } }),
    ).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { n: 1 },
    });
  });

  it("throws the joined text blocks on failure", () => {
    expect(() =>
      piToolResultOrThrow({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
        isError: true,
      }),
    ).toThrow("first\nsecond");
  });

  it("still throws when a failure carries no text", () => {
    expect(() => piToolResultOrThrow({ content: [], isError: true })).toThrow("Tool call failed");
  });
});
