// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-error contract against the REAL Pi agent loop (issue #1490), through
 * the production forwarder of the sidecar's tools (`buildMcpDirectFactories`).
 *
 * Pi ignores an `isError` returned from `execute`, so a forwarder's output
 * alone proves nothing. These tests serve one tool from an in-process MCP
 * server, register it through `buildMcpDirectFactories`, run one turn of a real
 * `createAgentSession` on Pi's faux provider, and read the verdict where it is
 * consumed: `tool_execution_end` (what `pi-runner` logs as `Tool error` /
 * `Tool result`) and the tool-result message the provider receives on the next
 * request.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createInProcessPair, wrapClient, type CallToolResult } from "@appstrate/mcp-transport";
import { loadPiCodingAgentSdk } from "@appstrate/runner-pi";
import type { ExtensionFactory } from "../pi-sdk.ts";
import { buildMcpDirectFactories } from "../mcp/direct.ts";

const TOOL = "probe__check";

interface ToolVerdict {
  /** `tool_execution_end.isError`. */
  isError: boolean;
  /** Text Pi recorded as the tool result. */
  text: string;
  /** `isError` on the tool-result message sent to the provider. */
  providerIsError: boolean | undefined;
}

/**
 * Run one real Pi turn in which the model calls {@link TOOL} once, the tool
 * answering `result` upstream, and return what Pi reported for that call.
 */
async function runToolCallThroughPi(result: CallToolResult): Promise<ToolVerdict> {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-error-"));
  const pair = await createInProcessPair([
    { descriptor: { name: TOOL, inputSchema: { type: "object" } }, handler: async () => result },
  ]);
  try {
    const toolFactories = await buildMcpDirectFactories({
      mcp: wrapClient(pair.client, { close: () => Promise.resolve() }),
      runId: "run_tool_error_contract",
      emit: () => {},
      workspace: dir,
    });
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
    await pair.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sidecar MCP tool results through the real Pi loop", () => {
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
