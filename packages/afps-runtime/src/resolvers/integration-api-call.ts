// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS integration `api_call` resolver.
 *
 * An integration that opts an auth into the `_meta["dev.appstrate/api"]`
 * vendor extension — backed by an auth whose `delivery.http` describes how to
 * inject the credential — exposes a generic credential-injecting HTTP tool per
 * opted-in auth (orthogonal to `source.kind`). On the
 * platform this surfaces as the sidecar's `{ns}__api_call` MCP tool
 * (`runtime-pi/sidecar/mcp.ts` + `api-call-credentials.ts`). This module is
 * the portable equivalent that the standalone `appstrate run` CLI uses to
 * inject credentials locally — no sidecar, no container.
 *
 * The reusable HTTP core lives in {@link makeApiCallTool} / {@link ApiCallFn}
 * (body streaming, `authorized_uris` matching, response serialisation), and
 * the shared outbound pipeline (SSRF blocklist + the redirect-follower with
 * per-hop SSRF / per-hop allowlist / hybrid credential-strip / cookie
 * capture) lives in `./api-call-engine.ts` — identical to the platform
 * sidecar's `executeApiCall`. This module is credential-source-specific:
 *
 *   - {@link LocalIntegrationResolver} reads a JSON creds file keyed by
 *     integration id and injects the credential header itself, then
 *     dispatches the upstream call through the shared engine's
 *     `guardedFetch` (offline / air-gapped dev — no refresh, no rotation).
 *     The engine adds the SSRF blocklist + redirect-follower the raw
 *     `fetch` path used to lack.
 *   - {@link RemoteAppstrateIntegrationResolver} forwards every call through
 *     a pinned Appstrate instance's `/api/credential-proxy/proxy` route, with
 *     the integration id as the `X-Integration-Id` scope marker. Credentials never
 *     leave the platform.
 *
 * Tool surface: one AFPS `Tool` per opted-in auth, named `{ns}__api_call`
 * (single auth) or `{ns}__api_call__{authToken}` (several) to match the
 * platform's namespacing. Short auth keys remain verbatim; long keys use the
 * same stable bounded token as the platform catalog. This is NOT a single
 * `api_call` dispatcher keyed by a providerId enum.
 */

import type { Bundle, Tool } from "./types.ts";
import {
  makeApiCallTool,
  resolveBodyForFetch,
  serializeFetchResponse,
  applyTransportHeaders,
  isReproducibleBody,
  matchesAuthorizedUriSpec,
  type ApiCallFn,
  type ApiCallMeta,
} from "./http-call-core.ts";
import {
  apiCallToolNameForAuth,
  assertUniqueApiToolAuthTokens,
} from "@appstrate/afps-shared/api-tool-naming";
import {
  allocateMcpToolNamespace,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";
import { guardedFetch, PreflightError, type HostResolver } from "./api-call-engine.ts";
import { AuthorizedUrisError, ResolverError } from "../errors.ts";
import { resolveHttpDelivery, type HttpDeliveryConfig } from "./http-delivery.ts";
import {
  projectHttpDeliveryConfig,
  type AfpsHttpDelivery,
} from "@appstrate/afps-shared/delivery-http";
import { substituteVars, referencesField } from "./template-vars.ts";
import { resolvePackageRef } from "./bundle-adapter.ts";

// ─────────────────────────────────────────────
// Integration refs + manifest projection
// ─────────────────────────────────────────────

/**
 * Reference to an integration the agent declared in
 * `dependencies.integrations`. Same npm-style `{ name, version }` shape
 * used for integration dependencies.
 */
export interface IntegrationRef {
  name: string;
  version: string;
}

/**
 * Flat runtime view of one api_call surface (a single opted-in auth), projected
 * from the integration manifest's `_meta["dev.appstrate/api"]` extension.
 * Carries everything the resolver needs to build a credential-injecting tool:
 * the auth's URL allowlist, the auth type, and the auth's `delivery.http`
 * config (if any).
 */
export interface ApiCallIntegrationMeta {
  /** Scoped package id (e.g. `@appstrate/gmail`). */
  name: string;
  /**
   * MCP-style namespace used to prefix the tool name. Defaults to the
   * slugified package id (matches the platform).
   */
  namespace: string;
  /**
   * Bare agent-facing tool name (before the `{namespace}__` prefix).
   * `api_call` when the integration opts in exactly one auth;
   * `api_call__{authToken}` when several.
   */
  toolName: string;
  /**
   * Auth key supplying credentials — one of the keys under
   * `_meta["dev.appstrate/api"].auths`.
   */
  authKey: string;
  /** Auth type (`oauth2` | `api_key` | `basic` | `custom`). */
  authType: string;
  /** URL allowlist enforced by the tool before dispatch. */
  authorizedUris: string[];
  /** When true, the tool skips the URL allowlist (SSRF blocklist still applies upstream). */
  allowAllUris: boolean;
  /** `auths.{key}.delivery.http`, when declared. Drives header injection in local mode. */
  http?: HttpDeliveryConfig;
}

/**
 * Derive {@link IntegrationRef}s from the bundle root manifest's
 * `dependencies.integrations` record (npm-style `id → semver` map). Mirrors
 * the integration dependency block (`dependencies.integrations`).
 */
export function readIntegrationRefs(bundle: Bundle): IntegrationRef[] {
  const root = bundle.packages.get(bundle.root);
  if (!root) return [];
  // AFPS §4.1 — each dependency value is a bare semver range string.
  // Per-integration configuration lives in the top-level
  // `integrations_configuration` map and is consumed by the platform-side
  // `parseManifestIntegrations` pass against the same manifest.
  const manifest = root.manifest as {
    dependencies?: { integrations?: Record<string, unknown> };
  };
  const integrations = manifest.dependencies?.integrations ?? {};
  const refs: IntegrationRef[] = [];
  for (const [name, raw] of Object.entries(integrations)) {
    if (typeof raw !== "string") continue;
    refs.push({ name, version: raw });
  }
  return refs;
}

/**
 * Project an integration manifest onto its {@link ApiCallIntegrationMeta}
 * surfaces — one per auth opted into `_meta["dev.appstrate/api"].auths`.
 * Returns `[]` when the integration declares no api_call (it is a pure
 * MCP-server integration with no generic call surface) — the caller skips it.
 */
export function readApiCallIntegrationMetas(
  bundle: Bundle,
  ref: IntegrationRef,
): ApiCallIntegrationMeta[] {
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
  return projectApiCallMetas(ref.name, parsed);
}

function projectApiCallMetas(name: string, parsed: unknown): ApiCallIntegrationMeta[] {
  if (!parsed || typeof parsed !== "object") return [];
  const m = parsed as {
    _meta?: Record<string, { auths?: Record<string, unknown> }>;
    auths?: Record<
      string,
      {
        type?: string;
        authorized_uris?: unknown;
        allow_all_uris?: unknown;
        delivery?: { http?: AfpsHttpDelivery };
      }
    >;
  };
  // api_call is the credential-injecting plane, declared via the
  // `_meta["dev.appstrate/api"].auths` vendor extension (orthogonal to
  // source.kind). Each opted-in auth that references a declared `auths.{key}`
  // yields one tool. Integrations without the extension expose no generic
  // tool — the caller skips them.
  const declaredAuths = m.auths ?? {};
  const metaAuths = m._meta?.["dev.appstrate/api"]?.auths;
  if (!metaAuths || typeof metaAuths !== "object" || Array.isArray(metaAuths)) return [];
  const authKeys = Object.keys(metaAuths).filter((k) => k in declaredAuths);
  if (authKeys.length === 0) return [];
  if (authKeys.length > 1) {
    try {
      assertUniqueApiToolAuthTokens(authKeys);
    } catch {
      return [];
    }
  }
  const namespace = normaliseMcpToolNamespace(name);
  const single = authKeys.length === 1;

  const out: ApiCallIntegrationMeta[] = [];
  for (const authKey of authKeys) {
    const auth = declaredAuths[authKey]!;
    const authorizedUris = Array.isArray(auth.authorized_uris)
      ? auth.authorized_uris.filter((u): u is string => typeof u === "string")
      : [];
    const allowAllUris = auth.allow_all_uris === true;
    const http = projectHttpDeliveryConfig(auth.delivery?.http);
    out.push({
      name,
      namespace,
      toolName: apiCallToolNameForAuth(authKey, !single),
      authKey,
      authType: typeof auth.type === "string" ? auth.type : "custom",
      authorizedUris,
      allowAllUris,
      ...(http ? { http } : {}),
    });
  }
  return out;
}

/** Build the {@link ApiCallMeta} the HTTP core uses for `authorizedUris` enforcement. */
function toApiCallMeta(meta: ApiCallIntegrationMeta): ApiCallMeta {
  return {
    name: meta.name,
    authorizedUris: meta.authorizedUris,
    allowAllUris: meta.allowAllUris,
  };
}

/** Tool name surfaced to the LLM, matching the platform's `{ns}__{toolName}`. */
export function apiCallToolName(meta: ApiCallIntegrationMeta): string {
  return `${meta.namespace}__${meta.toolName}`;
}

/**
 * Reserved Appstrate transport / credential headers (lowercased). The remote
 * resolver imposes these to route and authenticate the credential-proxy call;
 * the local resolver injects the integration's credential header itself. In
 * either case an agent-supplied `req.headers` entry must NEVER override them —
 * HTTP header names are case-insensitive, so the comparison is done on
 * lowercased names — otherwise a tool call could redirect the call to a
 * different target / integration, spoof the caller identity, or pre-seed the
 * credential header the resolver is about to set. Platform-imposed values are
 * always applied last so they win.
 */
const RESERVED_TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-application-id",
  "x-org-id",
  "x-session-id",
  "x-integration-id",
  "x-target",
  "appstrate-user",
]);

/**
 * True when `input` references at least one declared credential field via a
 * `{{field}}` placeholder. Used by the local resolver to detect a
 * credential-bearing call (the agent embedded the secret into the URL / a
 * header) so it can refuse to honour `allow_all_uris` and instead gate the
 * dispatch on the auth's `authorized_uris` allowlist — preventing secret
 * exfiltration to an arbitrary off-allowlist host.
 */
function referencesCredentialField(
  input: string,
  fields: Readonly<Record<string, string>>,
): boolean {
  return referencesField(input, fields);
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
 * Local creds file for integrations —
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
  /**
   * DNS resolver for the SSRF rebind preflight — injectable for tests.
   * Production callers omit it (system resolver via `node:dns`).
   */
  resolveHost?: HostResolver;
}

/**
 * {@link IntegrationApiCallResolver} that reads credentials from a local
 * JSON file and makes direct HTTP calls to the upstream API, injecting the
 * credential header itself. Intended for offline / air-gapped CLI runs —
 * no refresh, no rotation. Tokens expire; dev re-authenticates manually.
 */
export class LocalIntegrationResolver implements IntegrationApiCallResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: HostResolver | undefined;
  private creds: LocalIntegrationCredentialsFile | null;
  private readonly credsPath: string | null;

  constructor(opts: LocalIntegrationResolverOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.resolveHost = opts.resolveHost;
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
    const usedNamespaces = new Set<string>();
    for (const ref of refs) {
      const metas = readApiCallIntegrationMetas(bundle, ref);
      if (metas.length === 0) continue; // not an apiCall integration — skip
      const namespace = allocateMcpToolNamespace(metas[0]!.namespace, usedNamespaces);
      usedNamespaces.add(namespace);
      const entry = creds.integrations[ref.name];
      if (!entry) {
        throw new Error(
          `LocalIntegrationResolver: no credentials found for ${ref.name} in the local creds file`,
        );
      }
      for (const projectedMeta of metas) {
        const meta =
          projectedMeta.namespace === namespace ? projectedMeta : { ...projectedMeta, namespace };
        tools.push(
          makeApiCallTool(toApiCallMeta(meta), this.buildCall(meta, entry), {
            toolName: apiCallToolName(meta),
            description:
              `Make an authenticated request through the "${meta.name}" integration's ` +
              "credential-injecting proxy. Supply method, target URL, optional headers/body, " +
              "and responseMode. The target must match the integration auth's authorized_uris.",
          }),
        );
      }
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
  ): ApiCallFn {
    return async (req, ctx) => {
      const fields = entry.fields;

      // Detect credential exfiltration via `{{field}}` substitution: when the
      // agent embeds a decrypted credential field into the target URL or a
      // header, that call must NOT be allowed to reach an off-allowlist host
      // (see `allowAllUris` below). This is distinct from the credential
      // header the resolver injects itself — that one is protected on
      // cross-origin redirect hops by the shared engine's credential-strip,
      // and allow_all_uris integrations legitimately send it to the
      // agent-chosen first hop.
      let substitutesCredential = referencesCredentialField(req.target, fields);
      // A `{{field}}` credential reference in the request BODY is the same
      // exfiltration channel as one in the URL/headers — only a string body is
      // substituted (`transformString` below runs on strings only; multipart /
      // fromFile / fromBytes parts are never `{{}}`-substituted), so that is the
      // one shape to scan.
      if (typeof req.body === "string" && referencesCredentialField(req.body, fields)) {
        substitutesCredential = true;
      }
      const target = substituteVars(req.target, fields);

      // Strip agent overrides of reserved transport / credential headers
      // (case-insensitive) BEFORE substitution + injection, so a tool call
      // can neither spoof platform-imposed identity headers nor pre-seed the
      // credential header the resolver is about to set. Platform-injected
      // values are applied last (in `injectCredential`) and always win.
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (RESERVED_TRANSPORT_HEADERS.has(key.toLowerCase())) continue;
        if (referencesCredentialField(value, fields)) substitutesCredential = true;
        headers[key] = substituteVars(value, fields);
      }
      // Inject the credential header locally and capture its name so the
      // shared engine's redirect-follower knows which header to strip on
      // an out-of-boundary cross-origin hop.
      const injectedCredentialHeader = injectCredential(headers, meta, entry);

      // A call that substitutes a credential field into the agent-controlled
      // URL / headers / body MUST respect the auth's `authorized_uris`
      // allowlist — `allow_all_uris` is not honoured for it, so the secret
      // can't be exfiltrated to an arbitrary off-allowlist host.
      const allowAllUris = meta.allowAllUris && !substitutesCredential;

      // When allow_all_uris was the integration's ONLY permission (no
      // authorized_uris allowlist exists), downgrading the flag alone is not
      // enough: the engine's preflight would fall back to the internal-host
      // SSRF net and still let the call proceed to any PUBLIC host with the
      // credential embedded. Refuse outright instead — same semantics as the
      // sidecar's credential-proxy 403 for this exact case.
      // (`allowAllUris` is already false whenever `substitutesCredential` is
      // true — see its definition above — so only the allowlist matters here.)
      if (substitutesCredential && meta.authorizedUris.length === 0) {
        throw new ResolverError(
          "RESOLVER_CREDENTIAL_EXFIL_BLOCKED",
          `Integration ${meta.name}: the call substitutes a credential into an agent-controlled URL, header, or body but the integration declares no authorized_uris allowlist; refusing to prevent credential exfiltration.`,
          { integration: meta.name },
        );
      }

      const resolvedBody = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        workspace: ctx.workspace,
        transformString: (input) => substituteVars(input, fields),
      });

      if (resolvedBody.kind === "bytes" && resolvedBody.contentType) {
        headers["Content-Type"] = resolvedBody.contentType;
      }

      // Route through the shared engine — same SSRF blocklist + manual
      // redirect-follower (per-hop SSRF, per-hop authorized_uris,
      // hybrid credential-strip, userinfo/fragment stripping) the sidecar
      // uses. Previously this was a raw `fetch(target, …)` with default
      // `redirect: "follow"` and NO SSRF check — the gap this engine closes.
      const init: RequestInit & Record<string, unknown> = {
        method: req.method,
        headers,
        body: resolvedBody.kind === "bytes" ? resolvedBody.bytes : resolvedBody.stream,
        signal: ctx.signal,
      };
      if (resolvedBody.kind === "stream") init.duplex = "half";

      let res: Response;
      try {
        const result = await guardedFetch({
          url: target,
          init,
          fetchFn: this.fetchImpl,
          authorizedUris: meta.authorizedUris,
          allowAllUris,
          injectedCredentialHeader: injectedCredentialHeader?.toLowerCase() ?? null,
          integrationId: meta.name,
          resolveHost: this.resolveHost,
        });
        res = result.response;
      } catch (err) {
        // The shared engine throws on a refused initial target (SSRF /
        // off-allowlist) or a refused redirect hop. Surface these as a
        // typed resolver error rather than a bare fetch exception so the
        // CLI agent gets a clear, structured failure — the host is
        // redacted (a redirect target may carry `?token=…`).
        if (err instanceof PreflightError) {
          if (err.reason === "not_authorized") {
            throw new AuthorizedUrisError(
              "AUTHORIZED_URIS_MISMATCH",
              `Integration ${meta.name}: ${err.message}`,
              { integration: meta.name, target },
            );
          }
          throw new ResolverError(
            "RESOLVER_URL_BLOCKED",
            `Integration ${meta.name}: ${err.message}`,
            { integration: meta.name, target },
          );
        }
        if (err instanceof Error && err.name === "RedirectBlockedError") {
          throw new ResolverError(
            "RESOLVER_REDIRECT_BLOCKED",
            `Integration ${meta.name}: redirect blocked (${(err as { reason?: string }).reason})`,
            { integration: meta.name },
          );
        }
        throw err;
      }

      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
      });
    };
  }
}

/**
 * Inject the credential header into an outgoing request. Precedence:
 *   1. explicit `entry.injection` override (header name/prefix + template),
 *   2. the integration manifest's `delivery.http` plan (auth-type defaults
 *      applied) — mirrors `@appstrate/connect`'s `resolveHttpDelivery`.
 *
 * When neither yields a header (e.g. `custom` auth with no `delivery.http`),
 * nothing is injected — the agent supplies its own auth via `{{var}}`
 * substitution, as for a `custom` auth.
 *
 * Returns the name of the header it injected (or `null` when nothing was
 * injected) so the caller can hand it to the shared engine's
 * redirect-follower for cross-origin credential stripping.
 */
function injectCredential(
  headers: Record<string, string>,
  meta: ApiCallIntegrationMeta,
  entry: LocalIntegrationCredentialsFile["integrations"][string],
): string | null {
  const fields = entry.fields;

  // 1. Explicit override from the creds file.
  if (entry.injection) {
    const rendered = entry.injection.template
      ? substituteVars(entry.injection.template, fields)
      : (fields.api_key ?? fields.access_token);
    if (!rendered) return null;
    const headerName = entry.injection.headerName ?? "Authorization";
    const headerPrefix = entry.injection.headerPrefix ?? "";
    headers[headerName] = `${headerPrefix}${rendered}`;
    return headerName;
  }

  // 2. Manifest `delivery.http` plan (auth-type defaults).
  const plan = resolveHttpDelivery(meta.authType, fields, meta.http);
  if (!plan || !plan.headerName) return null;
  // `allowServerOverride: false` (default) → strip a caller-supplied header
  // of the same name before injecting (defence-in-depth, mirrors the sidecar).
  if (!plan.allowServerOverride) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === plan.headerName.toLowerCase()) delete headers[key];
    }
  }
  headers[plan.headerName] = `${plan.headerPrefix}${plan.value}`;
  return plan.headerName;
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
  /** Override the low-level HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * BYOI integration resolver — forwards every `api_call` through
 * `POST /api/credential-proxy/proxy` on a remote Appstrate instance, with
 * the integration id as the `X-Integration-Id` scope marker. The platform owns
 * credential injection server-side; the local agent never sees credentials.
 *
 * The credential-proxy route is provider/integration-agnostic — it gates on
 * the resolved connection's `authorized_uris` and injects the configured
 * header, identically across every `{ns}__api_call` surface.
 */
export class RemoteAppstrateIntegrationResolver implements IntegrationApiCallResolver {
  private readonly instance: string;
  private readonly apiKey: string;
  private readonly applicationId: string;
  private readonly orgId: string | undefined;
  private readonly endUserId: string | undefined;
  private readonly sessionId: string;
  private readonly extraHeaders: Record<string, string>;
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
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async resolve(refs: IntegrationRef[], bundle: Bundle): Promise<Tool[]> {
    const tools: Tool[] = [];
    const usedNamespaces = new Set<string>();
    for (const ref of refs) {
      const metas = readApiCallIntegrationMetas(bundle, ref);
      if (metas.length === 0) continue;
      const namespace = allocateMcpToolNamespace(metas[0]!.namespace, usedNamespaces);
      usedNamespaces.add(namespace);
      for (const projectedMeta of metas) {
        const meta =
          projectedMeta.namespace === namespace ? projectedMeta : { ...projectedMeta, namespace };
        // The platform enforces `authorized_uris` server-side — allow all
        // locally so the tool dispatches and lets the proxy gate.
        const remoteMeta: ApiCallMeta = { name: meta.name, allowAllUris: true };
        tools.push(
          makeApiCallTool(remoteMeta, this.buildCall(meta), {
            toolName: apiCallToolName(meta),
            description:
              `Make an authenticated request through the "${meta.name}" integration's ` +
              "credential-injecting proxy. Supply method, target URL, optional headers/body, " +
              "and responseMode. The target must match the integration auth's authorized_uris.",
          }),
        );
      }
    }
    return tools;
  }

  private buildCall(meta: ApiCallIntegrationMeta): ApiCallFn {
    return async (req, ctx) => {
      const resolved = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        allowStreaming: true,
        workspace: ctx.workspace,
      });
      // Apply the agent-supplied headers FIRST, with any reserved transport
      // header stripped (case-insensitively), then set the platform-controlled
      // headers LAST so they always win and cannot be overridden by a tool call.
      const sanitizedAgentHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (RESERVED_TRANSPORT_HEADERS.has(key.toLowerCase())) continue;
        sanitizedAgentHeaders[key] = value;
      }
      const baseHeaders: Record<string, string> = {
        ...sanitizedAgentHeaders,
        Authorization: `Bearer ${this.apiKey}`,
        "X-Application-Id": this.applicationId,
        ...(this.orgId ? { "X-Org-Id": this.orgId } : {}),
        "X-Session-Id": this.sessionId,
        "X-Integration-Id": meta.name,
        "X-Target": req.target,
        ...(this.endUserId ? { "Appstrate-User": this.endUserId } : {}),
        ...this.extraHeaders,
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

// Re-export the URL matcher so callers can reason about authorized_uris.
export { matchesAuthorizedUriSpec };
