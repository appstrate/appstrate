// SPDX-License-Identifier: Apache-2.0

/**
 * Capabilities exposed to a custom tool's `execute` callback as the 4th argument.
 *
 * `readResource` resolves an MCP `resource_link` URI (typically
 * `appstrate://api-response/{runId}/{ulid}`) returned by an integration's
 * `{ns}__api_call` tool when the upstream response exceeds
 * `INLINE_RESPONSE_THRESHOLD` (32 KB). Without this, a tool that fetches large
 * payloads would have to call the sidecar's MCP `resources/read` over HTTP
 * itself — duplicated boilerplate across every tool that consumes large API
 * responses.
 *
 * Outbound credentialed calls are NOT part of this surface: tools issue them
 * through the namespaced `{ns}__api_call` MCP tool the LLM also sees, so the
 * credential stays injected server-side by the sidecar (a core invariant)
 * and there is a single call path rather than a parallel 4th-arg one.
 *
 * The runtime that materialises this context lives in
 * `runtime-pi/entrypoint.ts`. Tool authors only consume the type.
 */
export interface AppstrateToolCtx {
  readResource: (uri: string) => Promise<{
    contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
  }>;
}

/** Late-binding accessor consumed by the runtime wrapper layer. */
export type AppstrateCtxProvider = () => AppstrateToolCtx;
