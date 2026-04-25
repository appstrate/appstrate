// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  makeProviderTool,
  readProviderMeta,
  resolveBodyForFetch,
  serializeFetchResponse,
  applyTransportHeaders,
  type ProviderCallFn,
  type ProviderCallRequest,
  type ProviderMeta,
} from "./provider-tool.ts";

export interface RemoteAppstrateProviderResolverOptions {
  /** Base URL of the Appstrate instance (e.g. `https://app.appstrate.com`). */
  instance: string;
  /** API key (ask_...) scoped with the `credential-proxy:call` permission. */
  apiKey: string;
  /** Application id (app_...) the API key is scoped to. */
  appId: string;
  /**
   * Org id (org_...) the caller operates under. Required when the bearer
   * is a dashboard-user JWT (interactive CLI): the `/api/credential-proxy`
   * org-context middleware derives `orgId` from the header in that mode.
   * Optional for API-key auth — keys pre-resolve the org inline.
   */
  orgId?: string;
  /** End-user to impersonate (eu_...). Optional. */
  endUserId?: string;
  /**
   * Session id — scopes the cookie jar on the Appstrate side. A fresh id
   * per CLI invocation is typical; persisting across invocations keeps
   * the jar warm for multi-step OAuth flows.
   */
  sessionId?: string;
  /**
   * Extra headers to attach to every credential-proxy call. Used by CLI
   * runners to propagate `X-Run-Id` so the resulting
   * `credential_proxy_usage` rows are attributable per-run for cost
   * rollup. Header names are forwarded verbatim; values must be strings.
   */
  extraHeaders?: Record<string, string>;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * BYOI ("Bring Your Own Instance") — `ProviderResolver` that forwards
 * every call to `POST /api/credential-proxy/proxy` on a remote Appstrate
 * instance. Credentials stay on that instance; the local agent never
 * sees them.
 *
 * Use case: the dev loop. Run an agent locally (CLI, fast iteration)
 * while still benefitting from credentials already configured in a
 * long-lived Appstrate deployment — no copy-pasting tokens into a local
 * creds.json every time they refresh.
 */
/**
 * Returns true when the body can be re-resolved from scratch for a retry.
 * Mirrors the same helper in sidecar-provider-resolver — kept local to
 * avoid a cross-file import of a small utility.
 */
function isReproducibleBody(body: ProviderCallRequest["body"]): boolean {
  if (body == null || typeof body === "string") return true;
  if (body instanceof Uint8Array) return true;
  if (
    typeof body === "object" &&
    ("fromFile" in body || "fromBytes" in body || "multipart" in body)
  )
    return true;
  return false;
}

export class RemoteAppstrateProviderResolver implements ProviderResolver {
  private readonly instance: string;
  private readonly apiKey: string;
  private readonly appId: string;
  private readonly orgId: string | undefined;
  private readonly endUserId: string | undefined;
  private readonly sessionId: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteAppstrateProviderResolverOptions) {
    if (!opts.instance) throw new Error("RemoteAppstrateProviderResolver: instance is required");
    if (!opts.apiKey) throw new Error("RemoteAppstrateProviderResolver: apiKey is required");
    if (!opts.appId) throw new Error("RemoteAppstrateProviderResolver: appId is required");
    this.instance = opts.instance.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.appId = opts.appId;
    this.orgId = opts.orgId;
    this.endUserId = opts.endUserId;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.extraHeaders = opts.extraHeaders ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
  }

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
      // Resolve the request body with streaming support (mirrors sidecar).
      // `allowStreaming: true` opts large `{ fromFile }` references
      // (> STREAMING_THRESHOLD = 1 MB) into the stream path so they are
      // piped to the credential-proxy without being read into memory first.
      const resolved = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        allowStreaming: true,
        workspace: ctx.workspace,
      });
      // The platform's `/api/credential-proxy/proxy` route owns upstream
      // credential injection server-side (mirror of the sidecar). The
      // agent only writes `X-Target` / `X-Provider` + the API-key
      // Bearer the route needs to authenticate the caller; the real
      // upstream auth header is pinned by the platform from the
      // provider manifest. The inbound `Authorization` is consumed by
      // api-key auth and stripped before reaching upstream, so there
      // is no collision.
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "X-App-Id": this.appId,
        ...(this.orgId ? { "X-Org-Id": this.orgId } : {}),
        "X-Session-Id": this.sessionId,
        "X-Provider": ref.name,
        "X-Target": req.target,
        ...(this.endUserId ? { "Appstrate-User": this.endUserId } : {}),
        ...this.extraHeaders,
        ...(req.headers ?? {}),
      };

      const wantsFile = typeof req.responseMode?.toFile === "string";
      const isStreamingBody = resolved.kind === "stream";

      // Apply transport headers (streaming + response mode hints).
      // Mirrors sidecar-provider-resolver.ts exactly via the shared helper.
      applyTransportHeaders(headers, {
        wantsFile,
        isStreamingBody,
        bodySize: isStreamingBody ? resolved.size : undefined,
        maxInlineBytes: req.responseMode?.maxInlineBytes,
      });

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

      let res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, init);

      // When the credential-proxy refreshed credentials server-side on a
      // streaming 401 it cannot replay the body — it sets X-Auth-Refreshed:
      // true and returns the 401. If our body is reproducible we retry once.
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
        const retryInit: RequestInit & Record<string, unknown> = {
          method: req.method,
          headers,
          signal: ctx.signal,
        };
        if (retryResolved.kind === "stream") {
          retryInit.body = retryResolved.stream;
          retryInit.duplex = "half";
        } else {
          retryInit.body = retryResolved.bytes;
        }
        res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, retryInit);
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
