// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
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
  /** End-user to impersonate (eu_...). Optional. */
  endUserId?: string;
  /**
   * Session id — scopes the cookie jar on the Appstrate side. A fresh id
   * per CLI invocation is typical; persisting across invocations keeps
   * the jar warm for multi-step OAuth flows.
   */
  sessionId?: string;
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
  private readonly endUserId: string | undefined;
  private readonly sessionId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteAppstrateProviderResolverOptions) {
    if (!opts.instance) throw new Error("RemoteAppstrateProviderResolver: instance is required");
    if (!opts.apiKey) throw new Error("RemoteAppstrateProviderResolver: apiKey is required");
    if (!opts.appId) throw new Error("RemoteAppstrateProviderResolver: appId is required");
    this.instance = opts.instance.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.appId = opts.appId;
    this.endUserId = opts.endUserId;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
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

  private buildCall(ref: ProviderRef, meta: ProviderMeta): ProviderCallFn {
    return async (req) => {
      const bodyBytes = await resolveBodyStream(req.body, { allowFromFile: true });
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "X-App-Id": this.appId,
        "X-Session-Id": this.sessionId,
        "X-Provider": ref.name,
        "X-Target": req.target,
        ...(this.endUserId ? { "Appstrate-User": this.endUserId } : {}),
        ...(req.headers ?? {}),
      };

      const res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, {
        method: req.method,
        headers,
        body: bodyBytes,
      });
      void meta;
      return serializeFetchResponse(res);
    };
  }
}
