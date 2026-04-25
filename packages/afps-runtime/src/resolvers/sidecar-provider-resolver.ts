// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  makeProviderTool,
  readProviderMeta,
  resolveBodyForFetch,
  serializeFetchResponse,
  applyTransportHeaders,
  isReproducibleBody,
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
      // Clone the base headers before the first applyTransportHeaders call
      // so we can re-apply fresh transport headers for the retry path with
      // the retry body's actual size — avoiding stale Content-Length values.
      const baseHeaders: Record<string, string> = {
        ...this.baseHeaders,
        ...(req.headers ?? {}),
        "X-Provider": ref.name,
        "X-Target": req.target,
      };
      const wantsFile = typeof req.responseMode?.toFile === "string";
      const isStreamingBody = resolved.kind === "stream";

      // Apply transport headers (streaming + response mode hints).
      // Uses the shared helper so both resolvers stay in lockstep.
      const headers = applyTransportHeaders(
        { ...baseHeaders },
        {
          wantsFile,
          isStreamingBody,
          bodySize: isStreamingBody ? resolved.size : undefined,
          maxInlineBytes: req.responseMode?.maxInlineBytes,
        },
      );

      // For multipart bodies, forward the Content-Type (including boundary)
      // computed during serialization. Bun/fetch would normally compute it
      // from a FormData body, but we serialize to bytes upfront so we must
      // set it explicitly.
      if (resolved.kind === "bytes" && resolved.contentType) {
        headers["Content-Type"] = resolved.contentType;
      }

      // Streaming uploads need duplex: "half" — required by the
      // fetch spec when the body is a ReadableStream.
      const init: RequestInit & Record<string, unknown> = {
        method: req.method,
        headers,
        signal: ctx.signal,
      };
      if (isStreamingBody) {
        init.body = resolved.stream;
        init.duplex = "half";
      } else {
        init.body = resolved.bytes;
      }
      let res = await this.fetchImpl(`${this.sidecarUrl}/proxy`, init);

      // When the sidecar refreshed credentials server-side on a streaming
      // 401 it cannot replay the body — it sets X-Auth-Refreshed: true and
      // returns the 401 as-is. If our body is reproducible we retry once
      // with a fresh resolution so the next request carries the new token.
      if (
        res.status === 401 &&
        res.headers.get("x-auth-refreshed") === "true" &&
        isReproducibleBody(req.body)
      ) {
        const retryResolved = await resolveBodyForFetch(req.body, {
          allowFromFile: true,
          allowStreaming: true,
          workspace: ctx.workspace,
        });
        // Re-apply transport headers from the clean base so Content-Length
        // reflects the retry body's actual size (not the first attempt's).
        const retryIsStreamingBody = retryResolved.kind === "stream";
        const retryHeaders = applyTransportHeaders(
          { ...baseHeaders },
          {
            wantsFile,
            isStreamingBody: retryIsStreamingBody,
            bodySize: retryIsStreamingBody ? retryResolved.size : undefined,
            maxInlineBytes: req.responseMode?.maxInlineBytes,
          },
        );
        if (retryResolved.kind === "bytes" && retryResolved.contentType) {
          retryHeaders["Content-Type"] = retryResolved.contentType;
        }
        const retryInit: RequestInit & Record<string, unknown> = {
          method: req.method,
          headers: retryHeaders,
          signal: ctx.signal,
        };
        if (retryIsStreamingBody) {
          retryInit.body = retryResolved.stream;
          retryInit.duplex = "half";
        } else {
          retryInit.body = retryResolved.bytes;
        }
        res = await this.fetchImpl(`${this.sidecarUrl}/proxy`, retryInit);
      }

      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        signal: ctx.signal,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
        ...(wantsFile ? { streaming: true } : {}),
      });
    };
  }
}
