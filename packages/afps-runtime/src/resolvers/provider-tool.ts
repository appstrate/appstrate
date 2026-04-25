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

import type { Bundle, JSONSchema, ProviderRef, Tool, ToolContext, ToolResult } from "./types.ts";
import { resolvePackageRef } from "./bundle-adapter.ts";
import { ProviderAuthorizationError, ResolverError } from "../errors.ts";

/**
 * Runtime projection of the provider manifest — a flat view over the
 * subset of fields that `makeProviderTool` actually consumes. The
 * canonical wire shape nests these fields under `definition.*` per AFPS
 * spec §7.5 / §8.6 (`authorizedUris`, `allowAllUris` are transversal
 * fields of the `definition` object); {@link readProviderMeta} projects
 * them onto this flat shape so enforcement code does not have to carry
 * the nesting.
 *
 * Credential header metadata (name / prefix / field name) is
 * deliberately NOT part of this type. Every shipped transport —
 * sidecar, credential-proxy, Local — owns credential injection itself:
 *
 *   - Sidecar + credential-proxy: read the metadata from the platform's
 *     internal credentials endpoint and write the header server-side.
 *     The runtime never sees the credential field at all.
 *   - Local: reads `injection` from the local creds file, not from the
 *     bundle manifest.
 *
 * Consequence: the tool schema surfaced to the LLM is identical across
 * auth modes and carries no hint of how the credential is transported.
 */
export interface ProviderMeta {
  /** Scoped package name (e.g. `@appstrate/gmail`). */
  name: string;
  /**
   * URL allowlist enforced by the tool before dispatch. Patterns follow
   * {@link matchesAuthorizedUriSpec} semantics (`*` = single path
   * segment, `**` = any substring).
   */
  authorizedUris?: string[];
  /**
   * When true, the tool does not enforce the URL allowlist — the
   * transport is expected to enforce it instead (e.g. Appstrate's
   * sidecar gates this server-side). Defaults to false.
   */
  allowAllUris?: boolean;
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
  const toolName = opts.toolName ?? providerToolName(meta.name);
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

/**
 * Canonical slug applied to every provider id before we form a tool name.
 * Strips a leading `@` and replaces any non-word character with `_` so
 * scoped package ids like `@appstrate/gmail` become safe tool identifiers.
 */
export function slugifyProviderId(providerId: string): string {
  return providerId.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * The tool name `makeProviderTool` registers for a given provider id.
 * Consumers that need to reference the tool before the resolver runs
 * (e.g. the platform system prompt listing connected providers) should
 * call this helper rather than recomputing the slug locally — any future
 * change to the slug rules only needs to land here.
 */
export function providerToolName(providerId: string): string {
  return `${slugifyProviderId(providerId)}_call`;
}

/**
 * Materialise a request body into a `BodyInit`-compatible value.
 * Handles the three shapes accepted by {@link ProviderCallRequest.body}:
 * strings (optionally transformed — e.g. placeholder substitution by
 * the local resolver), raw bytes (pass-through), and file references
 * (only resolved when `allowFromFile` is true; sidecar-based transports
 * disallow them since the sidecar has no workspace access).
 */
export async function resolveBodyStream(
  body: string | Uint8Array | null | { fromFile: string } | undefined,
  opts: { allowFromFile?: boolean; transformString?: (input: string) => string } = {},
): Promise<string | Uint8Array<ArrayBuffer> | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    return opts.transformString ? opts.transformString(body) : body;
  }
  if (body instanceof Uint8Array) return toArrayBufferUint8(body);
  if (!opts.allowFromFile) {
    throw new ResolverError(
      "RESOLVER_BODY_REFERENCE_FORBIDDEN",
      `resolveBodyStream: { fromFile: "${body.fromFile}" } body references need workspace access; pass a string/bytes body or use a resolver with allowFromFile`,
      { fromFile: body.fromFile },
    );
  }
  const fs = await import("node:fs/promises");
  return toArrayBufferUint8(await fs.readFile(body.fromFile));
}

function toArrayBufferUint8(source: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    source.buffer instanceof ArrayBuffer &&
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
  ) {
    return source as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

/**
 * Serialise a `fetch` response into the spec-shaped
 * {@link ProviderCallResponse} every resolver returns to the LLM. The
 * body is read once and inlined as UTF-8 — streaming to file is a
 * follow-up (`responseMode.toFile`, spec §16.2). Centralising lets us
 * add truncation, binary detection, and streaming in a single place.
 */
export async function serializeFetchResponse(res: Response): Promise<ProviderCallResponse> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const text = await res.text();
  return {
    status: res.status,
    headers,
    body: { inline: text, inlineEncoding: "utf8" },
  };
}

/**
 * Load a provider manifest from the bundle and project the fields
 * consumed at runtime into a flat {@link ProviderMeta}.
 *
 * Missing packages surface the explicit fallback so resolvers don't
 * accidentally share the same default — sidecar/remote paths trust the
 * transport to enforce the allowlist, while the local path refuses to
 * call an un-manifested provider. Sharing this helper keeps manifest
 * parsing in a single place for every resolver.
 *
 * Resolution order inside the provider's package:
 *   1. `provider.json` (AFPS 1.x convention)
 *   2. `manifest.json` (package manifest when no dedicated provider.json)
 *   3. In-memory `pkg.manifest` (the bundle builder's pre-parsed copy)
 *
 * Per AFPS spec §7.5 / §8.6, `authorizedUris` and `allowAllUris` live
 * under `manifest.definition` — they are read from there and exposed
 * flat on the returned meta.
 */
export function readProviderMeta(
  bundle: Bundle,
  ref: ProviderRef,
  fallbackAllowAllUris: boolean,
): ProviderMeta {
  const pkg = resolvePackageRef(bundle, ref);
  if (!pkg) return { name: ref.name, allowAllUris: fallbackAllowAllUris };
  for (const candidate of ["provider.json", "manifest.json"] as const) {
    const bytes = pkg.files.get(candidate);
    if (!bytes) continue;
    return projectProviderMeta(ref.name, JSON.parse(new TextDecoder().decode(bytes)));
  }
  // Package present but no manifest file — fall back to the in-memory
  // package manifest that the bundle builder already parsed for us.
  return projectProviderMeta(ref.name, pkg.manifest);
}

/**
 * Project a parsed provider manifest onto the flat {@link ProviderMeta}
 * shape consumed by the runtime. Reads from `definition.*` (the
 * canonical AFPS location per spec §7.5 / §8.6) and ignores any
 * top-level occurrences — the manifest wire shape is the single source
 * of truth.
 *
 * Only `authorizedUris` and `allowAllUris` are surfaced: every shipped
 * transport (sidecar, credential-proxy, Local) owns credential
 * injection itself, so the runtime never reads header name / prefix /
 * field name from the manifest.
 */
function projectProviderMeta(name: string, parsed: unknown): ProviderMeta {
  const definition =
    parsed && typeof parsed === "object" && "definition" in parsed
      ? ((parsed as { definition?: unknown }).definition ?? {})
      : {};
  const def = definition as {
    authorizedUris?: unknown;
    allowAllUris?: unknown;
  };
  const meta: ProviderMeta = { name };
  if (Array.isArray(def.authorizedUris)) {
    meta.authorizedUris = def.authorizedUris.filter((u): u is string => typeof u === "string");
  }
  if (typeof def.allowAllUris === "boolean") {
    meta.allowAllUris = def.allowAllUris;
  }
  return meta;
}

function enforceAuthorizedUris(meta: ProviderMeta, target: string): void {
  if (meta.allowAllUris) return;
  const patterns = meta.authorizedUris ?? [];
  if (patterns.length === 0) {
    throw new ProviderAuthorizationError(
      "PROVIDER_AUTHORIZED_URIS_EMPTY",
      `Provider ${meta.name}: authorizedUris allowlist is empty; every target is forbidden. ` +
        `Declare authorizedUris in the provider manifest or set allowAllUris: true.`,
      { provider: meta.name, target },
    );
  }
  for (const pattern of patterns) {
    if (matchesAuthorizedUriSpec(pattern, target)) return;
  }
  throw new ProviderAuthorizationError(
    "PROVIDER_AUTHORIZED_URIS_MISMATCH",
    `Provider ${meta.name}: target ${target} is not in authorizedUris allowlist`,
    { provider: meta.name, target, allowlist: patterns },
  );
}

/**
 * AFPS 1.3-spec URL allowlist matcher:
 *   - literal URLs (no wildcards)   → exact equality
 *   - `*`  (single path segment)    → regex `[^/]*`
 *   - `**` (any substring)          → regex `.*`
 *
 * All regex metacharacters in the pattern are escaped so pattern
 * authors cannot accidentally inject a regex.
 */
export function matchesAuthorizedUriSpec(pattern: string, target: string): boolean {
  const parsedPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§DOUBLESTAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLESTAR§§/g, ".*");
  const regex = new RegExp("^" + parsedPattern + "$");
  return regex.test(target);
}
