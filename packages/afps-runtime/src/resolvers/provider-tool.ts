// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Factory for the Tool that every {@link ProviderResolver} produces:
 * `<providerName>_call` (e.g. `gmail_call`, `clickup_call`). A single
 * shape is used across every resolver so agents see an identical
 * interface regardless of the backend wiring.
 *
 * Specification: `afps-spec/spec.md` §8.2, §8.4 — file-reference IO.
 */

import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.ts";

/**
 * Metadata the resolver extracts from the provider manifest shipped in
 * the bundle (`.agent-package/providers/{name}/provider.json`).
 */
export interface ProviderMeta {
  /** Scoped package name (e.g. `@afps/gmail`). */
  name: string;
  /** Optional URL allowlist enforced by the tool before dispatch. */
  authorizedUris?: string[];
  /**
   * When true, the tool does not enforce the URL allowlist — the
   * transport is expected to enforce it instead (e.g. Appstrate's
   * sidecar gates this server-side). Defaults to false.
   */
  allowAllUris?: boolean;
  /** Arbitrary manifest-level extras that resolvers want to forward. */
  [key: string]: unknown;
}

export interface ProviderCallRequest {
  method: string;
  target: string;
  headers?: Record<string, string>;
  /**
   * Request body. Either raw bytes / string (forwarded verbatim) or a
   * file reference that the transport resolves before dispatch.
   */
  body?: string | Uint8Array | null | { fromFile: string };
  /**
   * How the response should be surfaced back to the LLM. Defaults to
   * inline (bytes up to `maxInlineBytes`, file reference above).
   */
  responseMode?: {
    toFile?: string;
    maxInlineBytes?: number;
  };
}

export interface ProviderCallResponse {
  status: number;
  headers: Record<string, string>;
  body:
    | { inline: unknown; inlineEncoding?: "utf8" | "base64" | "none" }
    | { file: { path: string; size: number; contentType: string; sha256?: string } };
}

/**
 * Transport callback. Resolver implementations close over whatever
 * credential / transport state they need and hand this callback to
 * {@link makeProviderTool}.
 */
export type ProviderCallFn = (req: ProviderCallRequest) => Promise<ProviderCallResponse>;

export interface MakeProviderToolOptions {
  /** Tool name override. Defaults to `<sluggedProviderName>_call`. */
  toolName?: string;
  /** Description override. */
  description?: string;
  /** Stable per-call event shape emitted through ctx.emit. */
  emitProviderEvent?: boolean;
}

/**
 * Build a `Tool` exposing a typed provider-call surface to the LLM.
 * Agents see `gmail_call(method, target, headers?, body?, responseMode?)`
 * rather than a free-form `curl` invocation — same observability for
 * every resolver, no prompt-level knowledge of the transport.
 */
export function makeProviderTool(
  meta: ProviderMeta,
  call: ProviderCallFn,
  opts: MakeProviderToolOptions = {},
): Tool {
  const toolName = opts.toolName ?? `${slugify(meta.name)}_call`;
  const description =
    opts.description ??
    `Call the ${meta.name} provider. Supply method, target URL, optional headers/body, and responseMode. ` +
      `Binary payloads SHOULD be passed via { fromFile } on request and { toFile } on response — ` +
      `bytes embedded in tool arguments bloat the LLM context and are truncated.`;

  const parameters: JSONSchema = {
    type: "object",
    required: ["method", "target"],
    additionalProperties: false,
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
      target: { type: "string", description: "Absolute URL of the upstream endpoint" },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Headers forwarded to the upstream (credential headers are injected server-side)",
      },
      body: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["fromFile"],
            additionalProperties: false,
            properties: { fromFile: { type: "string" } },
          },
          { type: "null" },
        ],
      },
      responseMode: {
        type: "object",
        additionalProperties: false,
        properties: {
          toFile: {
            type: "string",
            description: "Workspace-relative path to stream the body into",
          },
          maxInlineBytes: { type: "integer", minimum: 0 },
        },
      },
    },
  };

  const emit = opts.emitProviderEvent ?? true;

  return {
    name: toolName,
    description,
    parameters,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const req = args as ProviderCallRequest;
      enforceAuthorizedUris(meta, req.target);

      const started = Date.now();
      let response: ProviderCallResponse;
      try {
        response = await call(req);
      } catch (err) {
        if (emit) {
          ctx.emit({
            type: "provider.called",
            timestamp: Date.now(),
            runId: ctx.runId,
            toolCallId: ctx.toolCallId,
            providerId: meta.name,
            method: req.method,
            target: req.target,
            status: 0,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }

      if (emit) {
        ctx.emit({
          type: "provider.called",
          timestamp: Date.now(),
          runId: ctx.runId,
          toolCallId: ctx.toolCallId,
          providerId: meta.name,
          method: req.method,
          target: req.target,
          status: response.status,
          durationMs: Date.now() - started,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: response.status,
              headers: response.headers,
              body: response.body,
            }),
          },
        ],
        ...(response.status >= 400 ? { isError: true } : {}),
      };
    },
  };
}

function slugify(name: string): string {
  return name.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

function enforceAuthorizedUris(meta: ProviderMeta, target: string): void {
  if (meta.allowAllUris) return;
  const patterns = meta.authorizedUris ?? [];
  if (patterns.length === 0) {
    throw new Error(
      `Provider ${meta.name}: authorizedUris allowlist is empty; every target is forbidden. ` +
        `Declare authorizedUris in the provider manifest or set allowAllUris: true.`,
    );
  }
  for (const pattern of patterns) {
    if (matchesUriPattern(pattern, target)) return;
  }
  throw new Error(`Provider ${meta.name}: target ${target} is not in authorizedUris allowlist`);
}

/**
 * Minimal glob matcher for URIs: `**` matches any substring (including
 * path separators); `*` matches any substring within a single path
 * segment. Sufficient for the authorizedUris patterns the AFPS spec
 * documents (e.g. `https://gmail.googleapis.com/**`).
 */
function matchesUriPattern(pattern: string, target: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§DOUBLESTAR§§/g, ".*") +
      "$",
  );
  return regex.test(target);
}
