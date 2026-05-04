// SPDX-License-Identifier: Apache-2.0

/**
 * Capabilities exposed to a custom tool's `execute` callback as the 4th argument.
 *
 * `providerCall` is the credentialed-call surface for tools, mirroring the
 * LLM-side `provider_call` MCP tool. The credential is injected server-side
 * by the sidecar — the tool never sees the raw key (ADR-003 invariant).
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
    content: Array<{ type: string; text?: string; resource?: { uri: string } }>;
    isError?: boolean;
    structuredContent?: unknown;
  }>;
}

/** Late-binding accessor consumed by the runtime wrapper layer. */
export type AppstrateCtxProvider = () => AppstrateToolCtx | null;
