// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  ABSOLUTE_MAX_RESPONSE_SIZE,
  makeProviderTool,
  readProviderMeta,
  resolveBodyStream,
  serializeFetchResponse,
  type ProviderCallFn,
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
      const bodyBytes = await resolveBodyStream(req.body, {
        allowFromFile: true,
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
      const maxInline = req.responseMode?.maxInlineBytes;
      const wantsFile = typeof req.responseMode?.toFile === "string";
      if (wantsFile || (typeof maxInline === "number" && maxInline > 0)) {
        const cap = wantsFile
          ? ABSOLUTE_MAX_RESPONSE_SIZE
          : Math.min(maxInline ?? 0, ABSOLUTE_MAX_RESPONSE_SIZE);
        headers["X-Max-Response-Size"] = String(cap);
      }

      const res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, {
        method: req.method,
        headers,
        body: bodyBytes,
        signal: ctx.signal,
      });
      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
      });
    };
  }
}
