// SPDX-License-Identifier: Apache-2.0

/**
 * Direct MCP tool surface (the only LLM-facing surface).
 *
 * Registers every namespaced `{ns}__{tool}` entry the sidecar advertises
 * (spawned, remote and in-process AFPS integrations) as a Pi-SDK tool
 * forwarding to the sidecar's MCP `tools/call` endpoint via
 * {@link AppstrateMcpClient}. The LLM sees the canonical
 * MCP names verbatim — Appstrate is indistinguishable (LLM-side) from
 * any other MCP host.
 *
 * This module does not build the system prompt: tool-usage prose lives in
 * each tool's MCP `description` (surfaced via `tools/list`), never here.
 */

import {
  isApiCallTool,
  isApiUploadTool,
  readApiCallToolKey,
  readApiUploadSiblingKey,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { unsafeSchema, type ExtensionFactory } from "../pi-sdk.ts";
import {
  callToolResultToPi,
  spillResourcesToWorkspace,
  type RuntimeEventEmitter,
} from "@appstrate/runner-pi";
import { buildApiUploadToolFactory } from "./api-upload-extension.ts";
import { resolveApiCallBody, ApiCallBodyResolveError } from "./api-call-body-resolver.ts";
import { shapeApiCallResponse } from "./api-call-response-resolver.ts";

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
}

/**
 * Build one forwarding Pi extension factory per tool the sidecar
 * advertises. The set is built once per agent.
 */
export async function buildMcpDirectFactories(
  opts: BuildMcpDirectFactoriesOptions,
): Promise<ExtensionFactory[]> {
  const { tools } = await opts.mcp.listTools();
  return buildIntegrationToolFactories(tools, opts);
}

/**
 * Wrap every tool advertised by the sidecar's MCP host
 * as a Pi extension that forwards to `mcp.callTool` verbatim. This is
 * how `{namespace}__{tool}` entries from spawned integration MCP servers
 * (including the generic `{ns}__api_call` tool) become callable from the
 * LLM side.
 */
function buildIntegrationToolFactories(
  advertised: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    _meta?: Record<string, unknown>;
  }>,
  opts: BuildMcpDirectFactoriesOptions,
): ExtensionFactory[] {
  const factories: ExtensionFactory[] = [];
  // Index every advertised api_call tool by BOTH its McpHost namespace and
  // the auth-scoped key stamped into its `_meta` marker. The key alone is not
  // globally unique: every single-auth integration legitimately uses
  // `api_call`, so a flat map would make Drive's upload dispatch through
  // Slack (or whichever integration happened to appear last in tools/list).
  //
  // `null` records an ambiguous scoped identity. That should be impossible
  // for trusted sidecar-generated descriptors, but can happen if an upstream
  // marker survives the trust boundary or tools/list contains duplicates. In
  // either case we fail closed and omit the upload tool instead of choosing a
  // sibling by order. Built up-front because tools/list gives no ordering
  // guarantee, so the upload tool may precede its sibling.
  const apiCallToolsByScopedKey = new Map<string, string | null>();
  for (const tool of advertised) {
    if (!isApiCallTool(tool)) continue;
    const key = readApiCallToolKey(tool);
    const scopedKey = key !== undefined ? namespacedToolKey(tool.name, key) : undefined;
    if (scopedKey === undefined) continue;
    if (apiCallToolsByScopedKey.has(scopedKey)) {
      apiCallToolsByScopedKey.set(scopedKey, null);
    } else {
      apiCallToolsByScopedKey.set(scopedKey, tool.name);
    }
  }
  for (const tool of advertised) {
    // `api_upload` tools are advertised by the sidecar (so the gating +
    // schema live in one place) but executed agent-side: the resolver reads
    // the workspace file, chunks it, and dispatches each chunk back through
    // the sibling `{ns}__api_call` tool. Route them to the dedicated
    // resolver instead of forwarding verbatim (a verbatim forward would hit
    // the sidecar's advertise-only error handler). Detected by the
    // `dev.appstrate/api-upload` `_meta` marker, not the tool name.
    if (isApiUploadTool(tool)) {
      // Gate the tool off entirely when the sibling can't be resolved: an
      // upload that cannot dispatch is a capability the LLM would call and
      // watch fail. `buildApiUploadToolFactory` gates the same way on an
      // undispatchable protocol.
      const siblingKey = readApiUploadSiblingKey(tool);
      const scopedKey =
        siblingKey !== undefined ? namespacedToolKey(tool.name, siblingKey) : undefined;
      const apiCallToolName =
        scopedKey !== undefined ? apiCallToolsByScopedKey.get(scopedKey) : undefined;
      if (typeof apiCallToolName !== "string") continue;
      factories.push(
        ...buildApiUploadToolFactory({
          tool,
          apiCallToolName,
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
        parameters: unsafeSchema<Record<string, unknown>>(
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
          // A tool reporting progress (relayed by the sidecar) is kept alive within
          // Pi's `signal`; one reporting none keeps the hard per-call timeout.
          const result = await opts.mcp.callTool(
            { name: tool.name, arguments: args },
            { ...(signal ? { signal } : {}), onProgress: () => {} },
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
          // api_call: surface the upstream HTTP status (otherwise dropped
          // with `_meta`) and honour `responseMode.toFile` — writing the body
          // to the agent-chosen workspace path and returning a file
          // descriptor. With no `toFile`, large bodies still auto-spill to
          // `resources/<file>` and the status line is prepended.
          if (apiCall) {
            let shaped: Awaited<ReturnType<typeof shapeApiCallResponse>>;
            try {
              shaped = await shapeApiCallResponse(result, {
                workspace: opts.workspace,
                ...(responseToFile !== undefined ? { toFile: responseToFile } : {}),
                toolCallId,
                runId: opts.runId,
                emit: opts.emit,
                readResource: (uri) => opts.mcp.readResource({ uri }),
              });
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
            // Outside the try: an upstream `isError` result throws here (Pi's
            // failure signal) and must not be re-worded as a write failure.
            return callToolResultToPi(shaped as Parameters<typeof callToolResultToPi>[0]);
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

/**
 * Pair a host-namespaced tool with an auth-scoped synthetic-tool key.
 * McpHost owns the first `__` separator; the remainder may itself contain
 * `__` for multi-auth names such as `api_call__primary`.
 */
function namespacedToolKey(toolName: string, authScopedKey: string): string | undefined {
  const separator = toolName.indexOf("__");
  if (separator <= 0) return undefined;
  return `${toolName.slice(0, separator)}\0${authScopedKey}`;
}
