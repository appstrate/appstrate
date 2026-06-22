// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface (the only LLM-facing surface).
 *
 * Registers `run_history` and `recall_memory` as Pi-SDK tools, each
 * forwarding to the sidecar's MCP `tools/call` endpoint via
 * {@link AppstrateMcpClient}, plus any namespaced `{ns}__{tool}` entry
 * advertised by a spawned AFPS integration. The LLM sees the canonical
 * MCP names verbatim — Appstrate is indistinguishable (LLM-side) from
 * any other MCP host.
 *
 * What this module deliberately does NOT do:
 *   - Sniff `tools/list` and re-derive the input schema for first-party
 *     tools. The schemas there are pinned to the sidecar's
 *     `mountMcp(...)` advertisement so a divergence between Pi tools and
 *     MCP tools is a one-line fix here, not silent re-validation drift.
 *   - Build the system prompt. We ship a 3-line capability prompt
 *     fragment via {@link DIRECT_TOOL_PROMPT}; the bundle owner
 *     decides whether to splice it in.
 *
 * The per-tool wiring (event emit → `mcp.callTool` → result-shape
 * adapter) for the runtime-injected tools lives in
 * `@appstrate/runner-pi/runtime-tools/mcp-forward`. This file is
 * orchestration-only.
 */

import { isApiCallTool, isApiUploadTool, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { Type, type ExtensionFactory } from "../pi-sdk.ts";
import {
  buildRuntimeToolFactories,
  callToolResultToPi,
  RUNTIME_INJECTED_TOOLS,
  spillResourcesToWorkspace,
  type RuntimeEventEmitter,
} from "@appstrate/runner-pi";
import { replayRuntimeToolEvents, type RuntimeToolDef } from "@appstrate/core/runtime-tool-defs";
import { buildApiUploadToolFactory } from "./api-upload-extension.ts";
import { resolveApiCallBody, ApiCallBodyResolveError } from "./api-call-body-resolver.ts";
import { shapeApiCallResponse } from "./api-call-response-resolver.ts";

/**
 * 3-line capability prompt (D5.1). Spliceable into a bundle's system
 * prompt — Sonnet 4+ tier models infer the rest from `tools/list`
 * natively.
 */
export const DIRECT_TOOL_PROMPT = [
  "## Capabilities",
  "You have access to MCP tools through the standard MCP protocol.",
  "Discover them via `tools/list`. Each tool's input schema is self-documenting.",
].join("\n");

interface BuildMcpDirectFactoriesOptions {
  mcp: AppstrateMcpClient;
  runId: string;
  emit: RuntimeEventEmitter;
  /**
   * Workspace root the agent's files live under. Required to resolve the
   * `fromFile` argument of `{ns}__api_upload` tools (resumable upload) —
   * the sidecar advertises those tools but the chunked upload is
   * orchestrated agent-side because the workspace is not visible to the
   * credential-isolated sidecar.
   */
  workspace: string;
  /**
   * The agent's selected first-party runtime tools (`log`/`note`/`pin`/`report`/
   * `output`), indexed by bare name — the SAME defs the sidecar serves. When a
   * forwarded tool call matches one, its canonical events are reconstructed by
   * replaying the local pure handler on the observed args (see
   * `replayRuntimeToolEvents`) rather than trusting the sidecar result's
   * `_meta`. This is the transport-agnostic capture shared with the Claude +
   * Codex runners, and it removes any trust in a result's `_meta`. Absent/empty
   * → no runtime tools (the map is also the first-party allowlist: integration
   * tools are namespaced `{ns}__{tool}` and never match).
   */
  runtimeDefs?: Map<string, RuntimeToolDef>;
}

/**
 * Build the `run_history` + `recall_memory` Pi extension factories plus
 * one forwarding factory per namespaced integration tool. The set is
 * built once per agent.
 *
 * `run_history` and `recall_memory` are wired by `runner-pi`'s
 * `buildRuntimeToolFactories`, which iterates {@link
 * RUNTIME_INJECTED_TOOLS} and produces one Pi-tool registration per
 * descriptor.
 */
export async function buildMcpDirectFactories(
  opts: BuildMcpDirectFactoriesOptions,
): Promise<ExtensionFactory[]> {
  // Discover the sidecar's tool surface so we can fail fast if the
  // expected tools are missing. The expected set is derived from the
  // shared `RUNTIME_INJECTED_TOOLS` descriptor list — adding a new
  // runtime tool to that list automatically updates this guard.
  const { tools } = await opts.mcp.listTools();
  const advertised = new Set(tools.map((t) => t.name));
  const expected = RUNTIME_INJECTED_TOOLS.map((t) => t.name);
  for (const name of expected) {
    if (!advertised.has(name)) {
      throw new Error(
        `MCP server does not advertise '${name}'. ` +
          `Tools available: ${[...advertised].join(", ") || "(none)"}`,
      );
    }
  }

  const factories: ExtensionFactory[] = [];
  factories.push(
    ...buildRuntimeToolFactories({
      mcp: opts.mcp,
      runId: opts.runId,
      emit: opts.emit,
    }),
  );
  // Phase 1.4 — integration tools. The sidecar's McpHost multiplexes
  // each spawned `type: integration` MCP server's tools as namespaced
  // entries (`{ns}__{tool}`). We mirror them as Pi tools that forward
  // verbatim to the sidecar's MCP `tools/call`. Any name we already
  // wired above (run_history / recall_memory) is skipped.
  const claimedNames = new Set<string>(RUNTIME_INJECTED_TOOLS.map((t) => t.name));
  factories.push(...buildIntegrationToolFactories(tools, claimedNames, opts));
  return factories;
}

/**
 * Wrap every non-first-party tool advertised by the sidecar's MCP host
 * as a Pi extension that forwards to `mcp.callTool` verbatim. This is
 * how `{namespace}__{tool}` entries from spawned integration MCP servers
 * (including the generic `{ns}__api_call` tool) become callable from the
 * LLM side (Phase 1.4).
 */
function buildIntegrationToolFactories(
  advertised: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    _meta?: Record<string, unknown>;
  }>,
  claimed: ReadonlySet<string>,
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  for (const tool of advertised) {
    if (claimed.has(tool.name)) continue;
    // `api_upload` tools are advertised by the sidecar (so the gating +
    // schema live in one place) but executed agent-side: the resolver reads
    // the workspace file, chunks it, and dispatches each chunk back through
    // the sibling `{ns}__api_call` tool. Route them to the dedicated
    // resolver instead of forwarding verbatim (a verbatim forward would hit
    // the sidecar's advertise-only error handler). Detected by the
    // `dev.appstrate/api-upload` `_meta` marker, not the tool name.
    if (isApiUploadTool(tool)) {
      factories.push(
        ...buildApiUploadToolFactory({
          tool,
          mcp: opts.mcp,
          runId: opts.runId,
          workspace: opts.workspace,
          emit: opts.emit,
        }),
      );
      continue;
    }
    // api_call tools accept `body: { fromFile }` — a workspace-relative
    // path the sidecar can't read (no workspace mount). Resolve the bytes
    // to the canonical `{ fromBytes }` wire form agent-side before
    // forwarding, keeping the large body out of the model context. The
    // `fromFile` variant is advertised by the sidecar's own schema; here we
    // only resolve it. Detected by the `dev.appstrate/api-call` `_meta`
    // marker, not the tool name.
    const apiCall = isApiCallTool(tool);
    factories.push((pi) => {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description ?? `Integration tool: ${tool.name}`,
        parameters: Type.Unsafe<Record<string, unknown>>(
          (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        ),
        async execute(toolCallId, params, signal) {
          const startedAt = Date.now();
          opts.emit({
            type: `integration_tool.called`,
            runId: opts.runId,
            tool: tool.name,
            toolCallId,
            timestamp: startedAt,
          });
          let args = (params as Record<string, unknown>) ?? {};
          // `responseMode` is an agent-side convenience (the sidecar has no
          // workspace): capture `toFile` and strip the field before
          // forwarding, so the response shaper writes the body to that path.
          let responseToFile: string | undefined;
          if (apiCall && args.responseMode !== undefined) {
            const rm = args.responseMode as { toFile?: unknown };
            if (rm && typeof rm.toFile === "string") responseToFile = rm.toFile;
            const { responseMode: _responseMode, ...rest } = args;
            args = rest;
          }
          if (apiCall && args.body !== undefined) {
            // Resolve `{ fromFile }` references to base64 wire form. A
            // resolution failure (missing file, symlink, oversize) is a
            // tool-level error the LLM can act on — not a run abort.
            try {
              args = {
                ...args,
                body: await resolveApiCallBody(args.body, { workspace: opts.workspace }),
              };
            } catch (err) {
              if (err instanceof ApiCallBodyResolveError) {
                opts.emit({
                  type: `integration_tool.completed`,
                  runId: opts.runId,
                  tool: tool.name,
                  toolCallId,
                  durationMs: Date.now() - startedAt,
                  isError: true,
                  timestamp: Date.now(),
                });
                return callToolResultToPi({
                  content: [{ type: "text" as const, text: err.message }],
                  isError: true,
                });
              }
              throw err;
            }
          }
          const result = await opts.mcp.callTool(
            { name: tool.name, arguments: args },
            { ...(signal ? { signal } : {}) },
          );
          opts.emit({
            type: `integration_tool.completed`,
            runId: opts.runId,
            tool: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: result.isError === true,
            timestamp: Date.now(),
          });
          // First-party runtime tools (output/log/note/pin/report): reconstruct
          // their canonical events by replaying the LOCAL pure handler on the
          // observed args — the transport-agnostic capture shared with the
          // Claude + Codex runners. We deliberately ignore the sidecar result's
          // `_meta`: trusting it would let any bare-named tool forge run
          // events, and the local replay is authoritative regardless of
          // transport. The `runtimeDefs` map IS the first-party allowlist —
          // integration tools are namespaced `{ns}__{tool}` and never match.
          const runtimeDef = opts.runtimeDefs?.get(tool.name);
          if (runtimeDef && result.isError !== true) {
            for (const ev of await replayRuntimeToolEvents(runtimeDef, args)) {
              opts.emit({ runId: opts.runId, timestamp: Date.now(), ...ev });
            }
          }
          // api_call: surface the upstream HTTP status (otherwise dropped
          // with `_meta`) and honour `responseMode.toFile` — writing the body
          // to the agent-chosen workspace path and returning a file
          // descriptor. With no `toFile`, large bodies still auto-spill to
          // `resources/<file>` and the status line is prepended.
          if (apiCall) {
            try {
              const shaped = await shapeApiCallResponse(result, {
                workspace: opts.workspace,
                ...(responseToFile !== undefined ? { toFile: responseToFile } : {}),
                toolCallId,
                runId: opts.runId,
                emit: opts.emit,
                readResource: (uri) => opts.mcp.readResource({ uri }),
              });
              return callToolResultToPi(shaped as Parameters<typeof callToolResultToPi>[0]);
            } catch (err) {
              // A bad responseMode.toFile path (escape/symlink) or a resource
              // read failure is a tool-level error, not a run abort.
              return callToolResultToPi({
                content: [
                  {
                    type: "text" as const,
                    text: `api_call: could not write response to ${JSON.stringify(responseToFile)}: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              });
            }
          }
          // Materialise MCP resources to workspace files before the adapter
          // flattens them, keeping file bytes out of the LLM context:
          //  - embedded `resource` blocks (GitHub MCP `get_file_contents`, …),
          //  - `resource_link` blocks fetched via `readResource` so the agent
          //    reads the file instead of an unreadable `appstrate://` URI.
          const spilled = await spillResourcesToWorkspace(result, {
            workspace: opts.workspace,
            toolCallId,
            emit: opts.emit,
            runId: opts.runId,
            readResource: (uri) => opts.mcp.readResource({ uri }),
          });
          return callToolResultToPi(spilled);
        },
      });
    });
  }
  return factories;
}
