// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  makeProviderTool,
  type ProviderCallFn,
  type ProviderCallResponse,
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
  /** Directory prefix for provider manifests in the bundle. */
  providerPrefix?: string;
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
  private readonly providerPrefix: string;

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
    this.providerPrefix = opts.providerPrefix ?? ".agent-package/providers/";
  }

  async resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = await readProviderMeta(bundle, ref, this.providerPrefix);
      tools.push(makeProviderTool(meta, this.buildCall(ref, meta)));
    }
    return tools;
  }

  private buildCall(ref: ProviderRef, meta: ProviderMeta): ProviderCallFn {
    return async (req) => {
      const bodyBytes = await resolveBodyStream(req.body);
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

      const respHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });
      const text = await res.text();
      const response: ProviderCallResponse = {
        status: res.status,
        headers: respHeaders,
        body: { inline: text, inlineEncoding: "utf8" },
      };
      void meta;
      return response;
    };
  }
}

async function readProviderMeta(
  bundle: Bundle,
  ref: ProviderRef,
  prefix: string,
): Promise<ProviderMeta> {
  const candidates = [`${prefix}${ref.name}/provider.json`, `${prefix}${ref.name}/manifest.json`];
  for (const path of candidates) {
    if (await bundle.exists(path)) {
      const raw = await bundle.readText(path);
      const parsed = JSON.parse(raw) as Partial<ProviderMeta>;
      return { name: ref.name, ...parsed };
    }
  }
  return { name: ref.name, allowAllUris: true };
}

async function resolveBodyStream(
  body: string | Uint8Array | null | { fromFile: string } | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if ("fromFile" in body) {
    const fs = await import("node:fs/promises");
    return new Uint8Array(await fs.readFile(body.fromFile));
  }
  return undefined;
}
