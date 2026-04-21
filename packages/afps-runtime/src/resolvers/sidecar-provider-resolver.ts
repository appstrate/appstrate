// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, ProviderRef, ProviderResolver, Tool } from "./types.ts";
import {
  makeProviderTool,
  readProviderMeta,
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
  /** Directory prefix for provider manifests in the bundle. */
  providerPrefix?: string;
}

/**
 * {@link ProviderResolver} that delegates to the Appstrate sidecar for
 * credential injection, URL enforcement, and transport. The sidecar
 * contract is unchanged — this resolver is a thin typed client.
 *
 * Credentials never transit the runtime: the sidecar fetches them from
 * the platform API using the per-run token and substitutes them into
 * the outgoing request before forwarding to the upstream provider.
 */
export class SidecarProviderResolver implements ProviderResolver {
  private readonly sidecarUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;
  private readonly providerPrefix: string;

  constructor(opts: SidecarProviderResolverOptions) {
    if (!opts.sidecarUrl) throw new Error("SidecarProviderResolver: sidecarUrl is required");
    this.sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseHeaders = opts.baseHeaders ?? {};
    this.providerPrefix = opts.providerPrefix ?? ".agent-package/providers/";
  }

  async resolve(refs: ProviderRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = await readProviderMeta(bundle, ref, this.providerPrefix, true);
      const call = this.buildCall(ref, meta);
      tools.push(makeProviderTool(meta, call));
    }
    return tools;
  }

  private buildCall(ref: ProviderRef, meta: ProviderMeta): ProviderCallFn {
    return async (req) => {
      const bodyBytes = await resolveBodyStream(req.body);
      const res = await this.fetchImpl(`${this.sidecarUrl}/proxy`, {
        method: req.method,
        headers: {
          ...this.baseHeaders,
          "X-Provider": ref.name,
          "X-Target": req.target,
          ...(req.headers ?? {}),
        },
        body: bodyBytes,
      });
      void meta;
      return serializeFetchResponse(res);
    };
  }
}

/**
 * Materialise the request body as a `BodyInit`-compatible value. File
 * references (`{ fromFile }`) are read from the workspace by the caller
 * — this helper only handles the string / Uint8Array / null cases so a
 * {@link SidecarProviderResolver} with no fs access still works.
 */
async function resolveBodyStream(
  body: string | Uint8Array | null | { fromFile: string } | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  throw new Error(
    `SidecarProviderResolver: { fromFile: "${body.fromFile}" } body references need workspace access; pass a string/bytes body or use LocalProviderResolver for file-ref IO`,
  );
}
