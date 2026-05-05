// SPDX-License-Identifier: Apache-2.0

/**
 * Capabilities exposed to a custom tool's `execute` callback as the 4th argument.
 *
 * `providerCall` is the credentialed-call surface for tools, mirroring the
 * LLM-side `provider_call` MCP tool. The credential is injected server-side
 * by the sidecar — the tool never sees the raw key (ADR-003 invariant).
 *
 * `readResource` resolves an MCP `resource_link` URI (typically
 * `appstrate://provider-response/{runId}/{ulid}`) returned by `providerCall`
 * when the upstream response exceeds `INLINE_RESPONSE_THRESHOLD` (32 KB).
 * Without this, a tool that fetches large payloads would have to call the
 * sidecar's MCP `resources/read` over HTTP itself — duplicated boilerplate
 * across every tool that consumes large API responses.
 *
 * The runtime that materialises this context (and validates `providerId`
 * against the agent bundle's `dependencies.providers[]`) lives in
 * `runtime-pi/entrypoint.ts`. Tool authors only consume the type.
 */
export interface AppstrateToolCtx {
  providerCall: (
    providerId: string,
    args: {
      method?: string;
      target: string;
      headers?: Record<string, string>;
      body?: string | { fromBytes: string; encoding: "base64" };
      responseMode?: { maxInlineBytes?: number; maxTotalBytes?: number };
      substituteBody?: boolean;
    },
  ) => Promise<{
    content: Array<
      | { type: "text"; text: string }
      | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
      | { type: string; text?: string; resource?: { uri: string } }
    >;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
  readResource: (uri: string) => Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }>;
}

/** Late-binding accessor consumed by the runtime wrapper layer. */
export type AppstrateCtxProvider = () => AppstrateToolCtx | null;
