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
    return async (req) => {
      const bodyBytes = await resolveBodyStream(req.body);
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
      const res = await this.fetchImpl(`${this.sidecarUrl}/proxy`, {
        method: req.method,
        headers,
        body: bodyBytes,
      });
      return serializeFetchResponse(res);
    };
  }
}
