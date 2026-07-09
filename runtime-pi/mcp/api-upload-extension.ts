// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side Pi extensions registering the LLM-facing `{ns}__api_upload`
 * tools for chunked uploads through an integration's `api_call`.
 *
 * Why a Pi extension and NOT a sidecar MCP tool:
 *   - The orchestration is purely client-side state (chunk index,
 *     session URL, ETag list) AND the file lives in the agent's
 *     workspace, which the sidecar deliberately cannot see. Putting it
 *     on the sidecar would require giving the sidecar workspace access —
 *     a hard line.
 *   - Each chunk transits through the integration's existing
 *     `{ns}__api_call` MCP tool, so credential isolation,
 *     `authorizedUris` gating, and `_meta` header propagation reuse
 *     already-shipped code paths.
 *
 * Tool gating:
 *   - The sidecar advertises a `{ns}__api_upload` tool only when the
 *     integration's `apiCall.uploadProtocols` is non-empty (see
 *     `makeApiUploadTool` in `sidecar/mcp.ts`). The descriptor's
 *     `uploadProtocol` enum is pinned to the integration's declared
 *     protocols, so the LLM can only call vetted combinations.
 *   - `direct.ts` discovers these advertised tools and routes each
 *     `{ns}__api_upload` to {@link buildApiUploadToolFactory} instead of
 *     forwarding verbatim to the sidecar (the sidecar has no workspace,
 *     so it cannot execute the upload — it only ADVERTISES the tool so
 *     the gating + schema live in one place). It also resolves the sibling
 *     api_call tool from the `_meta` marker payload and hands it in.
 */

import { Type, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";
import type { RuntimeEventEmitter } from "@appstrate/runner-pi";
import { McpApiUploadResolver } from "./api-upload-resolver.ts";
import { UPLOAD_PROTOCOLS, type UploadProtocol } from "./upload-adapters/index.ts";

/**
 * Extract the `uploadProtocol` enum the sidecar pinned into a
 * `{ns}__api_upload` descriptor's input schema, filtered to protocols
 * the resolver can actually dispatch (defence-in-depth against a sidecar
 * advertising a protocol with no registered adapter).
 */
function readDeclaredProtocols(inputSchema: unknown): UploadProtocol[] {
  const known = new Set<string>(UPLOAD_PROTOCOLS);
  const props = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const enumRaw = (props?.["uploadProtocol"] as { enum?: unknown } | undefined)?.enum;
  if (!Array.isArray(enumRaw)) return [];
  return enumRaw.filter((p): p is UploadProtocol => typeof p === "string" && known.has(p));
}

export interface BuildApiUploadFactoryOptions {
  /** The advertised `{ns}__api_upload` tool from the sidecar's `tools/list`. */
  tool: { name: string; description?: string; inputSchema?: unknown };
  /**
   * Advertised name of the sibling api_call tool each chunk is dispatched
   * through. Resolved by `direct.ts` from the upload descriptor's
   * `dev.appstrate/api-upload` `_meta` payload — an identity match against the
   * api_call tool that declared the same key, never a rewrite of this tool's
   * own name (which would break for the `api_upload__{authKey}` variants).
   */
  apiCallToolName: string;
  mcp: AppstrateMcpClient;
  runId: string;
  /** Workspace root the `fromFile` path is resolved against (symlink-safe). */
  workspace: string;
  emit: RuntimeEventEmitter;
}

/**
 * Build the Pi extension factory for one advertised `{ns}__api_upload`
 * tool. Returns `[]` when the descriptor declares no dispatchable
 * protocol — the tool is gated off entirely so the LLM doesn't see an
 * unusable capability.
 */
export function buildApiUploadToolFactory(opts: BuildApiUploadFactoryOptions): ExtensionFactory[] {
  const protocols = readDeclaredProtocols(opts.tool.inputSchema);
  if (protocols.length === 0) return [];
  return [makeExtension(protocols, opts)];
}

function makeExtension(
  protocols: UploadProtocol[],
  opts: BuildApiUploadFactoryOptions,
): ExtensionFactory {
  const toolName = opts.tool.name;
  const apiCallTool = opts.apiCallToolName;
  const allowed = new Set<UploadProtocol>(protocols);

  return (pi: ExtensionAPI) => {
    const resolver = new McpApiUploadResolver(opts.mcp);
    pi.registerTool({
      name: toolName,
      label: toolName,
      description:
        opts.tool.description ??
        "Upload a workspace file (>5 MB friendly) to this integration's API over a chunked " +
          "resumable protocol. Bytes flow through the credential-injecting proxy per chunk; " +
          "the agent never holds credentials. Returns the upstream's final response (file ID, " +
          "ETag, etc.) plus a SHA-256 of the bytes uploaded so post-upload verification is " +
          "possible.",
      parameters: Type.Unsafe<Record<string, unknown>>(
        (opts.tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          additionalProperties: false,
          required: ["target", "fromFile", "uploadProtocol"],
          properties: {
            target: { type: "string", format: "uri" },
            fromFile: { type: "string" },
            uploadProtocol: { type: "string", enum: protocols },
            metadata: { type: "object", additionalProperties: true },
            partSizeBytes: { type: "integer", minimum: 1 },
          },
        },
      ),
      async execute(toolCallId, params, signal) {
        const args = (params ?? {}) as {
          target?: string;
          fromFile?: string;
          uploadProtocol?: string;
          metadata?: Record<string, unknown>;
          partSizeBytes?: number;
        };

        const protocol = args.uploadProtocol;
        if (!protocol || !args.target || !args.fromFile) {
          return {
            content: [
              {
                type: "text",
                text: `${toolName}: missing one of target/fromFile/uploadProtocol`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        // Defence-in-depth: the LLM-facing schema's `enum` can be dropped
        // by older clients that don't enforce schemas — re-check here.
        if (!allowed.has(protocol as UploadProtocol)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `${toolName}: protocol '${protocol}' not declared by this integration. ` +
                  `Allowed: ${protocols.join(", ")}`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }

        const startedAt = Date.now();
        opts.emit({
          type: "api_upload.called",
          runId: opts.runId,
          tool: toolName,
          protocol,
          toolCallId,
          timestamp: startedAt,
        });

        const result = await resolver.executeUpload(
          {
            apiCallToolName: apiCallTool,
            target: args.target,
            fromFile: args.fromFile,
            uploadProtocol: protocol as UploadProtocol,
            metadata: args.metadata,
            ...(args.partSizeBytes !== undefined ? { partSizeBytes: args.partSizeBytes } : {}),
          },
          {
            workspace: opts.workspace,
            toolCallId,
            signal: signal ?? new AbortController().signal,
          },
        );

        opts.emit({
          type: result.ok ? "api_upload.completed" : "api_upload.failed",
          runId: opts.runId,
          tool: toolName,
          protocol,
          toolCallId,
          durationMs: Date.now() - startedAt,
          ...(result.ok
            ? { size: result.size, chunks: result.chunks, sha256: result.sha256 }
            : { status: result.status, bytesSent: result.bytesSent }),
          timestamp: Date.now(),
        });

        // Return a single text block with the structured result as JSON
        // so the LLM gets a uniform shape regardless of protocol.
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: undefined,
          isError: !result.ok,
        };
      },
    });
  };
}
