// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-error contract against the REAL Pi agent loop (issue #1490).
 *
 * Pi records a tool failure only when `execute` throws — a returned
 * `isError` is ignored. A unit test of the adapter alone cannot see that
 * (the pre-fix adapter's output looked plausible), so these tests register
 * the tool through the production factory, run one turn of a real
 * `createAgentSession` driven by Pi's faux provider, and read the verdict off
 * `tool_execution_end` — the event `pi-runner` turns into `Tool error` /
 * `Tool result`.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import { loadPiCodingAgentSdk, type ExtensionFactory } from "../src/pi-sdk.ts";
import { buildRuntimeToolFactories } from "../src/runtime-tools/mcp-forward.ts";
import { toPiToolResult } from "../src/pi-tool-result.ts";

const TOOL = "probe";

/** An MCP client whose only capability is answering `tools/call` with `result`. */
function mcpAnswering(result: CallToolResult): AppstrateMcpClient {
  return { callTool: async () => result } as unknown as AppstrateMcpClient;
}

interface ToolEnd {
  isError: boolean;
  text: string;
}

/**
 * Run one real Pi turn in which the model calls {@link TOOL} once, and return
 * what Pi reported for that call on `tool_execution_end`.
 */
async function runToolCallThroughPi(result: CallToolResult): Promise<ToolEnd> {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-error-"));
  try {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(TOOL, {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("done")),
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

    const ends: ToolEnd[] = [];
    session.subscribe((event) => {
      if (event.type !== "tool_execution_end") return;
      const blocks = (event.result as { content?: Array<{ type: string; text?: string }> }).content;
      ends.push({
        isError: event.isError,
        text: (blocks ?? []).map((b) => b.text ?? "").join(""),
      });
    });
    await session.prompt("call the probe");
    session.dispose();

    expect(ends).toHaveLength(1);
    return ends[0]!;
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
    expect(end.text).toBe('{ "error": "sftp failed (exit 1)" }');
  });

  it("records a normal MCP result as a success", async () => {
    const end = await runToolCallThroughPi({ content: [{ type: "text", text: "ok" }] });

    expect(end.isError).toBe(false);
    expect(end.text).toBe("ok");
  });
});

describe("toPiToolResult", () => {
  it("returns content and details on success", () => {
    expect(toPiToolResult({ content: [{ type: "text", text: "ok" }], details: { n: 1 } })).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { n: 1 },
    });
  });

  it("throws the joined text blocks on failure", () => {
    expect(() =>
      toPiToolResult({
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
    expect(() => toPiToolResult({ content: [], isError: true })).toThrow("Tool call failed");
  });
});
