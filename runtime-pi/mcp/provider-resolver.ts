// SPDX-License-Identifier: Apache-2.0

/**
 * `ProviderResolver` backed by an MCP `provider_call` tool.
 *
 * This is the container-mode counterpart to AFPS's
 * `RemoteAppstrateProviderResolver` (CLI's HTTP path) and `LocalProviderResolver`
 * (CLI's local-creds path). All three implement the same
 * `ProviderResolver` interface, which means `runner-pi`'s
 * `buildProviderCallExtensionFactory` is the single Pi-tool factory
 * across every execution mode — the LLM sees an identical
 * `provider_call({ providerId, method, target, body, … })` surface
 * whether the agent runs in Docker, in a CLI subprocess, or against a
 * remote Appstrate instance.
 *
 * Wire format
 * -----------
 * The agent's `body` is one of: `string` | `{ fromFile }` |
 * `{ fromBytes, encoding: "base64" }` | `{ multipart: [...] }`. AFPS's
 * {@link resolveBodyForFetch} reads workspace files for `fromFile` /
 * `multipart` parts (path-safe, lstat-checked) and returns either a
 * string or a `Uint8Array`. Strings are forwarded verbatim over
 * JSON-RPC; bytes are base64-encoded and shipped as
 * `{ fromBytes, encoding: "base64" }` because JSON-RPC has no native
 * byte type — UTF-8 round-tripping a non-text payload corrupts it.
 * The sidecar decodes the base64 once on the server and forwards the
 * bytes byte-for-byte to upstream.
 *
 * Response handling
 * -----------------
 * The MCP `provider_call` tool returns either an inline `text` block
 * (text/JSON under the inline threshold) or a `resource_link` block
 * (binary or oversize — the bytes live in the run-scoped BlobStore on
 * the sidecar). For `resource_link`, we fetch the bytes via
 * `mcp.readResource({ uri })` and synthesise a `Response` so the
 * canonical {@link serializeFetchResponse} pipeline (file routing for
 * `responseMode.toFile`, MIME sniffing, auto-spill at the inline cap)
 * runs identically to every other resolver path. The MCP layer
 * currently does not propagate upstream HTTP status / headers — the
 * response carries `status: 200` on success, and `isError: true`
 * tool-level errors surface as a synthetic 502.
 */

import {
  makeProviderTool,
  readProviderMeta,
  resolveBodyForFetch,
  serializeFetchResponse,
  type Bundle,
  type ProviderCallContext,
  type ProviderCallFn,
  type ProviderCallRequest,
  type ProviderCallResponse,
  type ProviderMeta,
  type ProviderRef,
  type ProviderResolver,
  type Tool,
} from "@appstrate/afps-runtime/resolvers";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";

const PROVIDER_CALL_TOOL_NAME = "provider_call";

/** MCP `body` shape carrying base64-encoded bytes. */
interface McpBytesBody {
  fromBytes: string;
  encoding: "base64";
}

/**
 * `ProviderResolver` that dispatches every provider call through an
 * `AppstrateMcpClient` connected to a sidecar exposing a
 * `provider_call` MCP tool.
 *
 * One instance per agent run — the MCP client owns the wire connection
 * (Streamable HTTP, stateless per-request transport) and the resolver
 * just builds typed tool callbacks over it.
 */
export class McpProviderResolver implements ProviderResolver {
  constructor(private readonly mcp: AppstrateMcpClient) {}

  async resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = readProviderMeta(bundle, ref, true);
      tools.push(makeProviderTool(meta, this.buildCall(ref, meta)));
    }
    return tools;
  }

  private buildCall(ref: ProviderRef, _meta: ProviderMeta): ProviderCallFn {
    return async (req, ctx) => {
      const args = await this.buildMcpArgs(ref, req, ctx);
      const result = await this.mcp.callTool(
        { name: PROVIDER_CALL_TOOL_NAME, arguments: args },
        { signal: ctx.signal },
      );
      return await this.callToolResultToResponse(result, req, ctx);
    };
  }

  /**
   * Resolve the agent-supplied request body into bytes (via
   * {@link resolveBodyForFetch}, with workspace-rooted path safety) and
   * package the call into the JSON-RPC `arguments` shape the sidecar's
   * `provider_call` MCP tool expects.
   *
   * `multipart` request bodies bring their own `Content-Type` header
   * (carrying the boundary) — preserved on the outgoing request.
   */
  private async buildMcpArgs(
    ref: ProviderRef,
    req: ProviderCallRequest,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    // `allowStreaming: false` — the MCP wire is a single JSON-RPC
    // envelope, not a streaming HTTP body. Large `{ fromFile }` uploads
    // are buffered to bytes here; AFPS's `MAX_REQUEST_BODY_SIZE` (5 MB)
    // is enforced inside the resolver itself.
    const resolved = await resolveBodyForFetch(req.body, {
      allowFromFile: true,
      allowStreaming: false,
      workspace: ctx.workspace,
    });

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let mcpBody: string | McpBytesBody | undefined;

    if (resolved.kind === "bytes") {
      const b = resolved.bytes;
      if (b === undefined) {
        // No body (GET/HEAD with body: null). Leave mcpBody undefined.
      } else if (typeof b === "string") {
        mcpBody = b;
      } else {
        mcpBody = { fromBytes: encodeBase64(b), encoding: "base64" };
      }
      // multipart bodies surface a precomputed Content-Type with the
      // boundary — fetch normally derives it from a FormData body, but
      // we ship raw bytes so we set it explicitly.
      if (resolved.contentType && !hasHeader(headers, "content-type")) {
        headers["Content-Type"] = resolved.contentType;
      }
    }

    const args: Record<string, unknown> = {
      providerId: ref.name,
      target: req.target,
      method: req.method,
    };
    if (Object.keys(headers).length > 0) args.headers = headers;
    if (mcpBody !== undefined) args.body = mcpBody;
    // Forward the substituteBody flag so the sidecar can perform
    // `{{credential}}` placeholder substitution on the buffered text
    // body before sending upstream. Without this propagation the agent's
    // declared substituteBody is silently dropped at the resolver and
    // upstream receives literal `{{email}}`/`{{password}}` strings.
    if (req.substituteBody) args.substituteBody = true;
    return args;
  }

  /**
   * Map an MCP `CallToolResult` back into a {@link ProviderCallResponse}
   * by synthesising a `Response` and routing it through
   * {@link serializeFetchResponse}. Reusing the canonical serializer
   * means file-routing (`responseMode.toFile`), auto-spill at the
   * inline cap, MIME sniffing, and SHA-256 hashing all behave
   * identically across resolver paths.
   *
   * Tool-level errors (`isError: true`) surface as a synthetic `502` so
   * the agent's view of "something went wrong upstream" is consistent
   * with the HTTP-backed `RemoteAppstrateProviderResolver`.
   */
  private async callToolResultToResponse(
    result: CallToolResult,
    req: ProviderCallRequest,
    ctx: ProviderCallContext,
  ): Promise<ProviderCallResponse> {
    if (result.isError) {
      // Concatenate every text block to give the agent a full error
      // message even when the sidecar split it across multiple blocks.
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
      return {
        status: 502,
        headers: {},
        body: { kind: "text", text: text || "provider_call: upstream error" },
      };
    }

    const block = result.content[0];
    if (!block) {
      return {
        status: 502,
        headers: {},
        body: { kind: "text", text: "provider_call: empty MCP result" },
      };
    }

    if (block.type === "text") {
      // The sidecar returns text bodies as-is for text/JSON/XML
      // upstream content-types. The original Content-Type is not
      // currently propagated over MCP, so we declare `text/plain;
      // charset=utf-8` — `serializeFetchResponse` will route it to
      // `body.kind === "text"` either way.
      const fake = new Response(block.text, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
      return await serializeFetchResponse(fake, this.serializeCtx(req, ctx));
    }

    if (block.type === "resource_link") {
      // Binary or oversize text — bytes live in the sidecar's BlobStore.
      const resource = await this.mcp.readResource({ uri: block.uri }, { signal: ctx.signal });
      const part = resource.contents[0];
      if (!part) {
        return {
          status: 502,
          headers: {},
          body: { kind: "text", text: `provider_call: empty resource ${block.uri}` },
        };
      }
      const mimeType = part.mimeType ?? block.mimeType ?? "application/octet-stream";
      let bytes: Uint8Array;
      if ("blob" in part && typeof part.blob === "string") {
        bytes = decodeBase64Loose(part.blob);
      } else if ("text" in part && typeof part.text === "string") {
        bytes = new TextEncoder().encode(part.text);
      } else {
        return {
          status: 502,
          headers: {},
          body: {
            kind: "text",
            text: `provider_call: resource ${block.uri} has no readable content`,
          },
        };
      }
      const fake = new Response(bytes, {
        status: 200,
        headers: { "content-type": mimeType },
      });
      return await serializeFetchResponse(fake, this.serializeCtx(req, ctx));
    }

    // resource (inline) and image blocks are not produced by the
    // sidecar's `provider_call` tool. Surface as a tool-level error so
    // the failure is visible rather than silently swallowed.
    return {
      status: 502,
      headers: {},
      body: {
        kind: "text",
        text: `provider_call: unexpected MCP content block of type '${block.type}'`,
      },
    };
  }

  private serializeCtx(req: ProviderCallRequest, ctx: ProviderCallContext) {
    return {
      workspace: ctx.workspace,
      toolCallId: ctx.toolCallId,
      signal: ctx.signal,
      ...(req.responseMode ? { responseMode: req.responseMode } : {}),
    };
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return true;
  }
  return false;
}

function encodeBase64(input: Uint8Array | ArrayBuffer): string {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(u8).toString("base64");
}

/**
 * Lenient base64 decode for resource bytes coming back from the MCP
 * server. Unlike the strict decoder used on the inbound `provider_call`
 * body (which refuses URL-safe / line-folded variants), the MCP SDK
 * may emit either alphabet — we accept both here because the bytes
 * are already trusted (they originated from our own sidecar).
 */
function decodeBase64Loose(s: string): Uint8Array {
  const buf = Buffer.from(s, "base64");
  const u8 = new Uint8Array(buf.byteLength);
  u8.set(buf);
  return u8;
}
