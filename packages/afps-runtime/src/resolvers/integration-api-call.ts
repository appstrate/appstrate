// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS integration `api_call` resolver (provider→integration unification).
 *
 * A serverless integration — one that declares `apiCall` and no `server`,
 * backed by a single auth whose `delivery.http` describes how to inject the
 * credential — exposes a generic credential-injecting HTTP tool. On the
 * platform this surfaces as the sidecar's `{ns}__api_call` MCP tool
 * (`runtime-pi/sidecar/mcp.ts` + `api-call-credentials.ts`). This module is
 * the portable equivalent that the standalone `appstrate run` CLI uses to
 * inject credentials locally — no sidecar, no container.
 *
 * The reusable HTTP core lives in {@link makeProviderTool} / {@link ProviderCallFn}
 * (body streaming, redirect handling, `authorizedUris` matching, response
 * serialisation). This module is credential-source-specific:
 *
 *   - {@link LocalIntegrationResolver} reads a JSON creds file keyed by
 *     integration id and injects the credential header itself (offline /
 *     air-gapped dev — no refresh, no rotation).
 *   - {@link RemoteAppstrateIntegrationResolver} forwards every call through
 *     a pinned Appstrate instance's `/api/credential-proxy/proxy` route, with
 *     the integration id as the `X-Provider` scope marker. Credentials never
 *     leave the platform.
 *
 * Tool surface: one AFPS `Tool` per apiCall integration, named
 * `{ns}__api_call` to match the platform's namespacing — NOT a single
 * `provider_call` dispatcher keyed by a providerId enum.
 */

import type { Bundle, Tool } from "./types.ts";
import {
  makeProviderTool,
  resolveBodyForFetch,
  serializeFetchResponse,
  applyTransportHeaders,
  isReproducibleBody,
  matchesAuthorizedUriSpec,
  type ProviderCallFn,
  type ProviderMeta,
} from "./provider-tool.ts";
import { resolvePackageRef } from "./bundle-adapter.ts";

// ─────────────────────────────────────────────
// Integration refs + manifest projection
// ─────────────────────────────────────────────

/**
 * Reference to an integration the agent declared in
 * `dependencies.integrations`. Same npm-style `{ name, version }` shape
 * used for providers/skills/tools.
 */
export interface IntegrationRef {
  name: string;
  version: string;
}

/**
 * Flat runtime view of an integration's `apiCall` surface, projected from
 * the integration manifest. Carries everything the resolver needs to build
 * a credential-injecting tool: the auth's URL allowlist, the auth type, and
 * the auth's `delivery.http` config (if any).
 */
export interface ApiCallIntegrationMeta {
  /** Scoped package id (e.g. `@appstrate/gmail`). */
  name: string;
  /**
   * MCP-style namespace used to name the tool `{namespace}__api_call`.
   * Defaults to the slugified package id (matches the platform).
   */
  namespace: string;
  /** Auth key supplying credentials (`apiCall.authKey` or the single auth). */
  authKey: string;
  /** Auth type (`oauth2` | `oauth1` | `api_key` | `basic` | `custom`). */
  authType: string;
  /** URL allowlist enforced by the tool before dispatch. */
  authorizedUris: string[];
  /** When true, the tool skips the URL allowlist (SSRF blocklist still applies upstream). */
  allowAllUris: boolean;
  /** `auths.{key}.delivery.http`, when declared. Drives header injection in local mode. */
  http?: HttpDeliveryConfig;
}

/** Subset of `auths.{key}.delivery.http` the local resolver consumes. */
export interface HttpDeliveryConfig {
  headerName?: string;
  headerPrefix?: string;
  valueFrom?: string | { template: string; encoding?: "base64" };
  allowServerOverride?: boolean;
}

/**
 * Derive {@link IntegrationRef}s from the bundle root manifest's
 * `dependencies.integrations` record (npm-style `id → semver` map). Mirrors
 * `readProviderRefs` but for the unified integration dependency block.
 */
export function readIntegrationRefs(bundle: Bundle): IntegrationRef[] {
  const root = bundle.packages.get(bundle.root);
  if (!root) return [];
  const manifest = root.manifest as {
    dependencies?: { integrations?: Record<string, string> };
  };
  const integrations = manifest.dependencies?.integrations ?? {};
  return Object.entries(integrations).map(([name, version]) => ({ name, version }));
}

/** Slugify a package id into a tool-name-safe namespace (matches platform). */
function slugifyNamespace(id: string): string {
  return id.replace(/^@/, "").replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Project an integration manifest onto {@link ApiCallIntegrationMeta}.
 * Returns `null` when the integration does NOT declare `apiCall` (it is a
 * pure MCP-server integration with no generic call surface) — the caller
 * skips it.
 */
export function readApiCallIntegrationMeta(
  bundle: Bundle,
  ref: IntegrationRef,
): ApiCallIntegrationMeta | null {
  const pkg = resolvePackageRef(bundle, ref);
  let parsed: unknown = pkg?.manifest;
  if (pkg) {
    for (const candidate of ["integration.json", "manifest.json"] as const) {
      const bytes = pkg.files.get(candidate);
      if (bytes) {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
        break;
      }
    }
  }
  return projectApiCallMeta(ref.name, parsed);
}

function projectApiCallMeta(name: string, parsed: unknown): ApiCallIntegrationMeta | null {
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as {
    apiCall?: { authKey?: string };
    auths?: Record<
      string,
      {
        type?: string;
        authorizedUris?: unknown;
        allowAllUris?: unknown;
        delivery?: { http?: HttpDeliveryConfig };
      }
    >;
  };
  if (!m.apiCall) return null;
  const auths = m.auths ?? {};
  const authKeys = Object.keys(auths);
  if (authKeys.length === 0) return null;
  // `apiCall.authKey` is optional when there's exactly one auth; otherwise it
  // disambiguates. Fall back to the single declared auth.
  const authKey = m.apiCall.authKey ?? (authKeys.length === 1 ? authKeys[0]! : undefined);
  if (!authKey) return null;
  const auth = auths[authKey];
  if (!auth) return null;

  const authorizedUris = Array.isArray(auth.authorizedUris)
    ? auth.authorizedUris.filter((u): u is string => typeof u === "string")
    : [];
  const allowAllUris = auth.allowAllUris === true;
  const http = auth.delivery?.http;

  return {
    name,
    namespace: slugifyNamespace(name),
    authKey,
    authType: typeof auth.type === "string" ? auth.type : "custom",
    authorizedUris,
    allowAllUris,
    ...(http ? { http } : {}),
  };
}

/** Build the {@link ProviderMeta} the HTTP core uses for `authorizedUris` enforcement. */
function toProviderMeta(meta: ApiCallIntegrationMeta): ProviderMeta {
  return {
    name: meta.name,
    authorizedUris: meta.authorizedUris,
    allowAllUris: meta.allowAllUris,
  };
}

/** Tool name surfaced to the LLM, matching the platform's `{ns}__api_call`. */
export function apiCallToolName(meta: ApiCallIntegrationMeta): string {
  return `${meta.namespace}__api_call`;
}

// ─────────────────────────────────────────────
// Resolver contract
// ─────────────────────────────────────────────

/**
 * Resolve a set of apiCall integrations into AFPS {@link Tool}s — one
 * `{ns}__api_call` tool per integration. Integrations that don't declare
 * `apiCall` are silently skipped (they have no generic call surface).
 */
export interface IntegrationApiCallResolver {
  resolve(refs: IntegrationRef[], bundle: Bundle): Promise<Tool[]>;
}

// ─────────────────────────────────────────────
// Local resolver
// ─────────────────────────────────────────────

/**
 * Local creds file for integrations — mirrors the provider creds file but
 * keyed by integration id. Each entry carries the decrypted credential
 * `fields` (exposed for `{{var}}` substitution into URL / headers / body)
 * and an optional `injection` override. When `injection` is omitted, the
 * resolver derives the header from the integration manifest's
 * `delivery.http` plan (auth-type defaults included).
 */
export interface LocalIntegrationCredentialsFile {
  version: number;
  integrations: Record<
    string,
    {
      /** Optional override of the manifest's auth key (rarely needed). */
      authKey?: string;
      /** Decrypted credential fields keyed by manifest field name. */
      fields: Record<string, string>;
      /** Explicit header injection override. Wins over the manifest plan. */
      injection?: {
        headerName?: string;
        headerPrefix?: string;
        /** Template rendered with `fields` (`{{var}}`). Falls back to api_key/access_token. */
        template?: string;
      };
    }
  >;
}

export interface LocalIntegrationResolverOptions {
  /** Path to a creds JSON file or an already-parsed object. */
  creds: string | LocalIntegrationCredentialsFile;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * {@link IntegrationApiCallResolver} that reads credentials from a local
 * JSON file and makes direct HTTP calls to the upstream API, injecting the
 * credential header itself. Intended for offline / air-gapped CLI runs —
 * no refresh, no rotation. Tokens expire; dev re-authenticates manually.
 */
export class LocalIntegrationResolver implements IntegrationApiCallResolver {
  private readonly fetchImpl: typeof fetch;
  private creds: LocalIntegrationCredentialsFile | null;
  private readonly credsPath: string | null;

  constructor(opts: LocalIntegrationResolverOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    if (typeof opts.creds === "string") {
      this.creds = null;
      this.credsPath = opts.creds;
    } else {
      this.creds = opts.creds;
      this.credsPath = null;
    }
  }

  async resolve(refs: IntegrationRef[], bundle: Bundle): Promise<Tool[]> {
    const creds = await this.loadCreds();
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = readApiCallIntegrationMeta(bundle, ref);
      if (!meta) continue; // not an apiCall integration — skip
      const entry = creds.integrations[ref.name];
      if (!entry) {
        throw new Error(
          `LocalIntegrationResolver: no credentials found for ${ref.name} in the local creds file`,
        );
      }
      tools.push(
        makeProviderTool(toProviderMeta(meta), this.buildCall(meta, entry), {
          toolName: apiCallToolName(meta),
          description:
            `Make an authenticated request through the "${meta.name}" integration's ` +
            "credential-injecting proxy. Supply method, target URL, optional headers/body, " +
            "and responseMode. The target must match the integration auth's authorizedUris.",
        }),
      );
    }
    return tools;
  }

  private async loadCreds(): Promise<LocalIntegrationCredentialsFile> {
    if (this.creds !== null) return this.creds;
    if (this.credsPath === null) {
      throw new Error("LocalIntegrationResolver: creds was neither a parsed object nor a path");
    }
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(this.credsPath, "utf8");
    this.creds = JSON.parse(raw) as LocalIntegrationCredentialsFile;
    return this.creds;
  }

  private buildCall(
    meta: ApiCallIntegrationMeta,
    entry: LocalIntegrationCredentialsFile["integrations"][string],
  ): ProviderCallFn {
    return async (req, ctx) => {
      const fields = entry.fields;
      const target = substituteVars(req.target, fields);
      const headers = { ...(req.headers ?? {}) };
      for (const [key, value] of Object.entries(headers)) {
        headers[key] = substituteVars(value, fields);
      }
      injectCredential(headers, meta, entry);

      const resolvedBody = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        workspace: ctx.workspace,
        transformString: (input) => substituteVars(input, fields),
      });

      if (resolvedBody.kind === "bytes" && resolvedBody.contentType) {
        headers["Content-Type"] = resolvedBody.contentType;
      }

      const res = await this.fetchImpl(target, {
        method: req.method,
        headers,
        body: resolvedBody.kind === "bytes" ? resolvedBody.bytes : resolvedBody.stream,
        signal: ctx.signal,
      });
      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
      });
    };
  }
}

/** `{{var}}` substitution shared with the provider local resolver. */
function substituteVars(input: string, fields: Record<string, string>): string {
  return input.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => fields[key] ?? "");
}

/**
 * Inject the credential header into an outgoing request. Precedence:
 *   1. explicit `entry.injection` override (header name/prefix + template),
 *   2. the integration manifest's `delivery.http` plan (auth-type defaults
 *      applied) — mirrors `@appstrate/connect`'s `resolveHttpDelivery`.
 *
 * When neither yields a header (e.g. `custom` auth with no `delivery.http`),
 * nothing is injected — the agent supplies its own auth via `{{var}}`
 * substitution, exactly like a legacy `custom` provider.
 */
function injectCredential(
  headers: Record<string, string>,
  meta: ApiCallIntegrationMeta,
  entry: LocalIntegrationCredentialsFile["integrations"][string],
): void {
  const fields = entry.fields;

  // 1. Explicit override from the creds file.
  if (entry.injection) {
    const rendered = entry.injection.template
      ? substituteVars(entry.injection.template, fields)
      : (fields.api_key ?? fields.access_token);
    if (!rendered) return;
    const headerName = entry.injection.headerName ?? "Authorization";
    const headerPrefix = entry.injection.headerPrefix ?? "";
    headers[headerName] = `${headerPrefix}${rendered}`;
    return;
  }

  // 2. Manifest `delivery.http` plan (auth-type defaults).
  const plan = resolveLocalHttpDelivery(meta.authType, fields, meta.http);
  if (!plan || !plan.headerName) return;
  // `allowServerOverride: false` (default) → strip a caller-supplied header
  // of the same name before injecting (defence-in-depth, mirrors the sidecar).
  if (!plan.allowServerOverride) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === plan.headerName.toLowerCase()) delete headers[key];
    }
  }
  headers[plan.headerName] = `${plan.headerPrefix}${plan.value}`;
}

/**
 * Auth-type → header injection defaults. Portable mirror of
 * `@appstrate/connect`'s `AUTH_TYPE_HTTP_DEFAULTS` (afps-runtime cannot
 * depend on the platform's connect package).
 */
const AUTH_TYPE_HTTP_DEFAULTS: Readonly<
  Record<string, { headerName: string; headerPrefix: string; valueFrom: string }>
> = {
  oauth2: { headerName: "Authorization", headerPrefix: "Bearer ", valueFrom: "access_token" },
  oauth1: { headerName: "Authorization", headerPrefix: "", valueFrom: "access_token" },
  api_key: { headerName: "X-Api-Key", headerPrefix: "", valueFrom: "api_key" },
  basic: { headerName: "Authorization", headerPrefix: "Basic ", valueFrom: "" },
  custom: { headerName: "", headerPrefix: "", valueFrom: "" },
};

/** camelCase manifest alias → snake_case storage key (mirrors connect's ALIAS_MAP). */
const ALIAS_MAP: Readonly<Record<string, string>> = {
  accessToken: "access_token",
  refreshToken: "refresh_token",
  apiKey: "api_key",
};
const REVERSE_ALIAS_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALIAS_MAP).map(([camel, snake]) => [snake, camel]),
);

function readCredentialField(fields: Record<string, string>, name: string): string | undefined {
  if (fields[name] !== undefined) return fields[name];
  const alias = ALIAS_MAP[name] ?? REVERSE_ALIAS_MAP[name];
  if (alias && fields[alias] !== undefined) return fields[alias];
  return undefined;
}

interface LocalHttpDeliveryPlan {
  headerName: string;
  headerPrefix: string;
  value: string;
  allowServerOverride: boolean;
}

/**
 * Portable equivalent of `@appstrate/connect`'s `resolveHttpDelivery`.
 * Resolves a `delivery.http` plan for one auth, applying auth-type defaults.
 * Returns `null` when no header can be injected.
 */
function resolveLocalHttpDelivery(
  authType: string,
  fields: Record<string, string>,
  http: HttpDeliveryConfig | undefined,
): LocalHttpDeliveryPlan | null {
  const defaults = AUTH_TYPE_HTTP_DEFAULTS[authType] ?? {
    headerName: "",
    headerPrefix: "",
    valueFrom: "",
  };
  const headerName = http?.headerName ?? defaults.headerName;
  if (!headerName) return null;
  const headerPrefix = http?.headerPrefix ?? defaults.headerPrefix;

  let value: string;
  const valueFrom = http?.valueFrom ?? defaults.valueFrom;
  if (typeof valueFrom === "string") {
    value = valueFrom.length === 0 ? "" : (readCredentialField(fields, valueFrom) ?? "");
  } else {
    const rendered = valueFrom.template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
      return readCredentialField(fields, key) ?? "";
    });
    value =
      valueFrom.encoding === "base64" ? Buffer.from(rendered, "utf8").toString("base64") : rendered;
  }

  if (value.length === 0 && authType === "basic" && !http?.valueFrom) {
    const username = readCredentialField(fields, "username") ?? "";
    const password = readCredentialField(fields, "password") ?? "";
    value = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  }

  return {
    headerName,
    headerPrefix,
    value,
    allowServerOverride: http?.allowServerOverride === true,
  };
}

// ─────────────────────────────────────────────
// Remote resolver
// ─────────────────────────────────────────────

export interface RemoteAppstrateIntegrationResolverOptions {
  /** Base URL of the Appstrate instance. */
  instance: string;
  /** API key (ask_...) or device-flow JWT with `credential-proxy:call`. */
  apiKey: string;
  /** Application id (app_...) the caller is scoped to. */
  applicationId: string;
  /** Org id (org_...) — required for JWT auth. Optional for API-key auth. */
  orgId?: string;
  /** End-user to impersonate (eu_...). Optional. */
  endUserId?: string;
  /** Session id scoping the platform-side cookie jar. Defaults to a fresh UUID. */
  sessionId?: string;
  /** Extra headers attached to every credential-proxy call (e.g. `X-Run-Id`). */
  extraHeaders?: Record<string, string>;
  /** Default connection profile id (`X-Connection-Profile-Id`). */
  connectionProfileId?: string;
  /** Per-integration profile id overrides (`@scope/name` → uuid). */
  integrationProfileOverrides?: Record<string, string>;
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * BYOI integration resolver — forwards every `api_call` through
 * `POST /api/credential-proxy/proxy` on a remote Appstrate instance, with
 * the integration id as the `X-Provider` scope marker. The platform owns
 * credential injection server-side; the local agent never sees credentials.
 *
 * The credential-proxy route is provider/integration-agnostic — it gates on
 * the resolved connection's `authorizedUris` and injects the configured
 * header, identically for the legacy `provider_call` and the unified
 * `api_call` surface.
 */
export class RemoteAppstrateIntegrationResolver implements IntegrationApiCallResolver {
  private readonly instance: string;
  private readonly apiKey: string;
  private readonly applicationId: string;
  private readonly orgId: string | undefined;
  private readonly endUserId: string | undefined;
  private readonly sessionId: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly connectionProfileId: string | undefined;
  private readonly integrationProfileOverrides: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteAppstrateIntegrationResolverOptions) {
    if (!opts.instance) throw new Error("RemoteAppstrateIntegrationResolver: instance is required");
    if (!opts.apiKey) throw new Error("RemoteAppstrateIntegrationResolver: apiKey is required");
    if (!opts.applicationId)
      throw new Error("RemoteAppstrateIntegrationResolver: applicationId is required");
    this.instance = opts.instance.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.applicationId = opts.applicationId;
    this.orgId = opts.orgId;
    this.endUserId = opts.endUserId;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.extraHeaders = opts.extraHeaders ?? {};
    this.connectionProfileId = opts.connectionProfileId;
    this.integrationProfileOverrides = opts.integrationProfileOverrides ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async resolve(refs: IntegrationRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const ref of refs) {
      const meta = readApiCallIntegrationMeta(bundle, ref);
      if (!meta) continue;
      // The platform enforces `authorizedUris` server-side — allow all
      // locally so the tool dispatches and lets the proxy gate.
      const remoteMeta: ProviderMeta = { name: meta.name, allowAllUris: true };
      tools.push(
        makeProviderTool(remoteMeta, this.buildCall(meta), {
          toolName: apiCallToolName(meta),
          description:
            `Make an authenticated request through the "${meta.name}" integration's ` +
            "credential-injecting proxy. Supply method, target URL, optional headers/body, " +
            "and responseMode. The target must match the integration auth's authorizedUris.",
        }),
      );
    }
    return tools;
  }

  private buildCall(meta: ApiCallIntegrationMeta): ProviderCallFn {
    return async (req, ctx) => {
      const resolved = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        allowStreaming: true,
        workspace: ctx.workspace,
      });
      const profileForCall =
        this.integrationProfileOverrides[meta.name] ?? this.connectionProfileId;
      const baseHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "X-Application-Id": this.applicationId,
        ...(this.orgId ? { "X-Org-Id": this.orgId } : {}),
        "X-Session-Id": this.sessionId,
        "X-Provider": meta.name,
        "X-Target": req.target,
        ...(this.endUserId ? { "Appstrate-User": this.endUserId } : {}),
        ...(profileForCall ? { "X-Connection-Profile-Id": profileForCall } : {}),
        ...this.extraHeaders,
        ...(req.headers ?? {}),
      };

      const wantsFile = typeof req.responseMode?.toFile === "string";
      const isStreamingBody = resolved.kind === "stream";

      const headers = applyTransportHeaders(
        { ...baseHeaders },
        {
          wantsFile,
          isStreamingBody,
          bodySize: isStreamingBody ? resolved.size : undefined,
          maxInlineBytes: req.responseMode?.maxInlineBytes,
        },
      );
      if (resolved.kind === "bytes" && resolved.contentType) {
        headers["Content-Type"] = resolved.contentType;
      }

      const init: RequestInit & Record<string, unknown> = {
        method: req.method,
        headers,
        signal: ctx.signal,
      };
      if (isStreamingBody) {
        init.body = resolved.stream;
        init.duplex = "half";
      } else {
        init.body = resolved.bytes;
      }

      let res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, init);

      if (
        res.status === 401 &&
        res.headers.get("x-auth-refreshed") === "true" &&
        isReproducibleBody(req.body)
      ) {
        const retryResolved = await resolveBodyForFetch(req.body, {
          allowFromFile: true,
          allowStreaming: true,
          workspace: ctx.workspace,
        });
        const retryIsStreamingBody = retryResolved.kind === "stream";
        const retryHeaders = applyTransportHeaders(
          { ...baseHeaders },
          {
            wantsFile,
            isStreamingBody: retryIsStreamingBody,
            bodySize: retryIsStreamingBody ? retryResolved.size : undefined,
            maxInlineBytes: req.responseMode?.maxInlineBytes,
          },
        );
        if (retryResolved.kind === "bytes" && retryResolved.contentType) {
          retryHeaders["Content-Type"] = retryResolved.contentType;
        }
        const retryInit: RequestInit & Record<string, unknown> = {
          method: req.method,
          headers: retryHeaders,
          signal: ctx.signal,
        };
        if (retryIsStreamingBody) {
          retryInit.body = retryResolved.stream;
          retryInit.duplex = "half";
        } else {
          retryInit.body = retryResolved.bytes;
        }
        res = await this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, retryInit);
      }

      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        signal: ctx.signal,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
        ...(wantsFile ? { streaming: true } : {}),
      });
    };
  }
}

// Re-export the URL matcher so callers can reason about authorizedUris.
export { matchesAuthorizedUriSpec };
