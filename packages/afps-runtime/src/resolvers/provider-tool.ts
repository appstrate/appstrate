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

/**
 * Runtime projection of the provider manifest — a flat view over the
 * subset of fields that `makeProviderTool` actually consumes. The
 * canonical wire shape nests these fields under `definition.*` per AFPS
 * spec §7.5 / §8.6 (`authorizedUris`, `allowAllUris` are transversal
 * fields of the `definition` object); {@link readProviderMeta} projects
 * them onto this flat shape so enforcement code does not have to carry
 * the nesting.
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
  /**
   * Header name the upstream expects the credential under — e.g.
   * `Authorization` for Bearer tokens, `X-Api-Key` for API keys.
   * Projected from `manifest.definition.credentialHeaderName`.
   */
  credentialHeaderName?: string;
  /**
   * Prefix prepended to the credential value (e.g. `Bearer`). Rendered
   * as `${prefix} {{placeholder}}` when a prefix is set, otherwise the
   * placeholder is written on its own. Projected from
   * `manifest.definition.credentialHeaderPrefix`.
   */
  credentialHeaderPrefix?: string;
  /**
   * Name of the credential field the transport will substitute into the
   * `{{placeholder}}` at dispatch time — typically `access_token` for
   * OAuth providers and `api_key` for api-key providers. Projected from
   * `manifest.definition.credentials.fieldName`; callers fall back to a
   * default derived from `authMode` when absent.
   */
  credentialPlaceholder?: string;
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
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    return opts.transformString ? opts.transformString(body) : body;
  }
  if (body instanceof Uint8Array) return body;
  if (!opts.allowFromFile) {
    throw new Error(
      `resolveBodyStream: { fromFile: "${body.fromFile}" } body references need workspace access; pass a string/bytes body or use a resolver with allowFromFile`,
    );
  }
  const fs = await import("node:fs/promises");
  return new Uint8Array(await fs.readFile(body.fromFile));
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
 * shape consumed by the runtime. Reads every projected field from
 * `definition.*` (the canonical AFPS location) and ignores any
 * top-level occurrences — the manifest wire shape is the single source
 * of truth.
 *
 * The credential-injection fields (`credentialHeaderName`,
 * `credentialHeaderPrefix`, `credentialPlaceholder`) are what let the
 * sidecar/remote resolvers build an `Authorization: Bearer
 * {{access_token}}`-style header at dispatch time without hard-coding
 * transport conventions in the LLM-facing tool schema.
 */
function projectProviderMeta(name: string, parsed: unknown): ProviderMeta {
  const definition =
    parsed && typeof parsed === "object" && "definition" in parsed
      ? ((parsed as { definition?: unknown }).definition ?? {})
      : {};
  const def = definition as {
    authMode?: unknown;
    authorizedUris?: unknown;
    allowAllUris?: unknown;
    credentialHeaderName?: unknown;
    credentialHeaderPrefix?: unknown;
    credentials?: unknown;
  };
  const meta: ProviderMeta = { name };
  if (Array.isArray(def.authorizedUris)) {
    meta.authorizedUris = def.authorizedUris.filter((u): u is string => typeof u === "string");
  }
  if (typeof def.allowAllUris === "boolean") {
    meta.allowAllUris = def.allowAllUris;
  }
  if (typeof def.credentialHeaderName === "string" && def.credentialHeaderName.length > 0) {
    meta.credentialHeaderName = def.credentialHeaderName;
  }
  if (typeof def.credentialHeaderPrefix === "string") {
    meta.credentialHeaderPrefix = def.credentialHeaderPrefix;
  }
  const credentialsObj =
    def.credentials && typeof def.credentials === "object"
      ? (def.credentials as { fieldName?: unknown })
      : null;
  const explicitField =
    credentialsObj && typeof credentialsObj.fieldName === "string"
      ? credentialsObj.fieldName
      : undefined;
  const placeholder = explicitField ?? defaultCredentialPlaceholder(def.authMode);
  if (placeholder) {
    meta.credentialPlaceholder = placeholder;
  }
  return meta;
}

/**
 * Default credential placeholder name per auth mode when the manifest
 * does not pin one explicitly. Mirrors the conventions enforced by the
 * platform's `buildSidecarCredentials` helper: OAuth flows expose the
 * live bearer as `access_token`, api-key flows expose the secret as
 * `api_key`. Modes that don't map to a single placeholder (`basic`,
 * `custom`) return `undefined` — the LLM must populate the header
 * itself for those.
 */
function defaultCredentialPlaceholder(authMode: unknown): string | undefined {
  if (authMode === "oauth2" || authMode === "oauth1") return "access_token";
  if (authMode === "api_key") return "api_key";
  return undefined;
}

/**
 * Build the credential header value that gets injected into an
 * outgoing provider call — e.g. `Bearer {{access_token}}`. Returns
 * `undefined` when the manifest doesn't carry enough metadata to
 * determine what to inject (no headerName, or no placeholder); callers
 * treat that as "skip injection, the LLM / transport handles it".
 *
 * Exported so resolvers that speak the sidecar substitution contract
 * (Sidecar, RemoteAppstrate) share one implementation. Local / offline
 * resolvers handle injection differently (they substitute locally).
 */
export function buildCredentialHeader(
  meta: ProviderMeta,
): { name: string; value: string } | undefined {
  if (!meta.credentialHeaderName || !meta.credentialPlaceholder) return undefined;
  const placeholder = `{{${meta.credentialPlaceholder}}}`;
  const prefix = meta.credentialHeaderPrefix?.trim();
  const value = prefix ? `${prefix} ${placeholder}` : placeholder;
  return { name: meta.credentialHeaderName, value };
}

/**
 * Merge caller-supplied headers with the credential header derived
 * from {@link buildCredentialHeader}. Caller headers win on
 * case-insensitive match — if the LLM explicitly set the auth header,
 * we respect the override rather than silently clobbering it.
 */
export function applyCredentialHeader(
  callerHeaders: Record<string, string> | undefined,
  meta: ProviderMeta,
): Record<string, string> {
  const caller = callerHeaders ?? {};
  const creds = buildCredentialHeader(meta);
  if (!creds) return { ...caller };
  const lowerCaller = new Set(Object.keys(caller).map((k) => k.toLowerCase()));
  if (lowerCaller.has(creds.name.toLowerCase())) return { ...caller };
  return { [creds.name]: creds.value, ...caller };
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
    if (matchesAuthorizedUriSpec(pattern, target)) return;
  }
  throw new Error(`Provider ${meta.name}: target ${target} is not in authorizedUris allowlist`);
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
