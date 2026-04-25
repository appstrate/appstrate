// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  ABSOLUTE_MAX_RESPONSE_SIZE,
  makeProviderTool,
  readProviderMeta,
  resolveBodyForFetch,
  serializeFetchResponse,
  type ProviderCallFn,
  type ProviderMeta,
} from "./provider-tool.ts";

export interface SidecarProviderResolverOptions {
  /**
   * Base URL of the sidecar proxy. Normally `http://sidecar:8080` inside
   * an Appstrate-orchestrated container; can be any URL that implements
   * the `/proxy` contract described in `runtime-pi/sidecar/server.ts`.
   */
  sidecarUrl: string;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Extra headers to forward on every request (e.g. tracing). Headers
   * set per-call by the LLM override these.
   */
  baseHeaders?: Record<string, string>;
}

/**
 * {@link ProviderResolver} that delegates to the Appstrate sidecar for
 * credential injection, URL enforcement, and transport. The sidecar
 * contract is unchanged — this resolver is a thin typed client.
 *
 * Credentials never transit the runtime: the sidecar fetches them from
 * the platform API using the per-run token and substitutes them into
 * the outgoing request before forwarding to the upstream provider.
 *
 * Workspace-rooted file IO ({@link ProviderCallRequest.body.fromFile} /
 * {@link ProviderCallRequest.responseMode.toFile}) is allowed: the
 * runtime resolves the path safely under the run workspace and streams
 * bytes through to / from the sidecar without UTF-8 decoding. The
 * sidecar itself has no workspace access — it only sees the
 * already-materialised request body and the upstream response bytes.
 */
export class SidecarProviderResolver implements ProviderResolver {
  private readonly sidecarUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(opts: SidecarProviderResolverOptions) {
    if (!opts.sidecarUrl) throw new Error("SidecarProviderResolver: sidecarUrl is required");
    this.sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseHeaders = opts.baseHeaders ?? {};
  }

  async resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = readProviderMeta(bundle, ref, true);
      const call = this.buildCall(ref, meta);
      tools.push(makeProviderTool(meta, call));
    }
    return tools;
  }

  private buildCall(ref: ProviderRef, _meta: ProviderMeta): ProviderCallFn {
    return async (req, ctx) => {
      // Resolve the request body. `allowStreaming` opts the upload
      // path into streaming mode for `{ fromFile }` references larger
      // than STREAMING_THRESHOLD (1 MB) — the file is read lazily and
      // piped to the sidecar with `duplex: "half"`, keeping memory
      // bound regardless of file size. Smaller bodies stay buffered
      // so the sidecar's transparent 401-refresh-and-retry path keeps
      // working unchanged.
      const resolved = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        allowStreaming: true,
        workspace: ctx.workspace,
      });
      // The sidecar owns credential injection server-side — it fetches
      // the full provider payload (credentials + header name + prefix +
      // field name) from the platform and writes the upstream auth
      // header itself. The agent's `<provider>_call` tool never touches
      // a credential placeholder, so nothing from the manifest's
      // transport metadata needs to travel through this resolver.
      const headers: Record<string, string> = {
        ...this.baseHeaders,
        ...(req.headers ?? {}),
        "X-Provider": ref.name,
        "X-Target": req.target,
      };
      // Routing the response to a file? Opt the sidecar into the
      // zero-copy streaming response path (X-Stream-Response: 1) so
      // it pipes upstream bytes through without buffering or
      // truncation. The runtime then writes them to disk
      // incrementally via writeStreamToFile, which is bounded by
      // MAX_STREAMED_BODY_SIZE on this side.
      const wantsFile = typeof req.responseMode?.toFile === "string";
      if (wantsFile) {
        headers["X-Stream-Response"] = "1";
      } else {
        // Inline-only path: lift the sidecar's default cap when the
        // agent explicitly asks for a larger inline payload. Without
        // this the sidecar truncates at MAX_RESPONSE_SIZE and the
        // resolver never sees the bytes that should have spilled.
        const maxInline = req.responseMode?.maxInlineBytes;
        if (typeof maxInline === "number" && maxInline > 0) {
          const cap = Math.min(maxInline, ABSOLUTE_MAX_RESPONSE_SIZE);
          headers["X-Max-Response-Size"] = String(cap);
        }
      }
      // Streaming uploads need duplex: "half" — required by the
      // fetch spec when the body is a ReadableStream.
      const init: RequestInit & Record<string, unknown> = {
        method: req.method,
        headers,
        signal: ctx.signal,
      };
      if (resolved.kind === "stream") {
        init.body = resolved.stream;
        init.duplex = "half";
        // Some upstreams require an explicit Content-Length on
        // streaming uploads. We set it on the sidecar request — the
        // sidecar already forwards request headers, including this
        // one, so the upstream sees a properly framed body.
        if (!("content-length" in headers) && !("Content-Length" in headers)) {
          headers["Content-Length"] = String(resolved.size);
        }
      } else {
        init.body = resolved.bytes;
      }
      const res = await this.fetchImpl(`${this.sidecarUrl}/proxy`, init);
      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
        ...(wantsFile ? { streaming: true } : {}),
      });
    };
  }
}
