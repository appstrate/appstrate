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
 * the outbound half is `fetchApiCall` (`./api-call-engine.ts`). This module is
 * credential-source-specific:
 *
 *   - {@link LocalIntegrationResolver} reads a JSON creds file keyed by
 *     integration id and injects the credential header itself (offline /
 *     air-gapped dev — no refresh, no rotation).
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

import type { Tool } from "@afps-spec/types";
import type { Bundle } from "../bundle/types.ts";
import {
  makeApiCallTool,
  resolveBodyForFetch,
  serializeFetchResponse,
  applyTransportHeaders,
  isReproducibleBody,
  type ApiCallFn,
} from "./http-call-core.ts";
import { renderAuthorizedUris } from "@appstrate/afps-shared/authorized-uris";
import {
  apiCallToolNameForAuth,
  assertUniqueApiToolAuthTokens,
} from "@appstrate/afps-shared/api-tool-naming";
import {
  allocateMcpToolNamespace,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";
import type { HostResolver } from "@appstrate/afps-shared/ssrf-dns";
import { classifyApiCallFailure, fetchApiCall, forwardableHeaders } from "./api-call-engine.ts";
import { URL_POLICY_REFUSAL_CODE, type ApiCallFailureCode } from "./api-call-failure-codes.ts";
import { ApiCallFailureError, ResolverError } from "../errors.ts";
import {
  planHttpDeliveryInjection,
  resolveHttpDelivery,
  type HttpDeliveryConfig,
  type HttpDeliveryPlan,
} from "./http-delivery.ts";
import {
  InvalidHeaderValueError,
  isBareAuthSchemePrefix,
  projectHttpDeliveryConfig,
  type AfpsHttpDelivery,
} from "@appstrate/afps-shared/delivery-http";
import { substituteVars, templateHost } from "./template-vars.ts";
import { prepareApiCallRequest } from "./api-call-request.ts";
import {
  credentialUrlPolicy,
  redactionFields,
  urlPolicyRefusalMessage,
} from "./credential-guard.ts";
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
interface ApiCallIntegrationMeta {
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
  /** DECLARED `authorized_uris`, unrendered: `{$credential.<field>}` entries render per connection. */
  authorizedUris: string[];
  /** When true, the call skips the URL allowlist (SSRF blocklist still applies upstream). */
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
  return projectApiCallMetas(ref.name, readIntegrationManifest(bundle, ref));
}

/**
 * The integration manifest `ref` resolves to in the bundle, unvalidated: its
 * `integration.json` (else `manifest.json`) file, else the package's parsed
 * manifest; `undefined` when the bundle does not carry the package.
 */
export function readIntegrationManifest(bundle: Bundle, ref: IntegrationRef): unknown {
  const pkg = resolvePackageRef(bundle, ref);
  if (!pkg) return undefined;
  for (const candidate of ["integration.json", "manifest.json"] as const) {
    const bytes = pkg.files.get(candidate);
    if (bytes) return JSON.parse(new TextDecoder().decode(bytes));
  }
  return pkg.manifest;
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

/**
 * Tool name surfaced to the LLM, matching the platform's `{ns}__{toolName}`.
 *
 * Package-internal: exported only so `test/resolvers/integration-api-call.test.ts`
 * can pin the 56-character tool name cap.
 */
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
  "x-space-id",
  "x-org-id",
  "x-session-id",
  "x-integration-id",
  "x-target",
  "appstrate-user",
  // Set by the platform (`extraHeaders`) to scope the call to its run; an agent
  // copy under another casing would merge into "a, b" and break the call.
  // `x-connection-id` stays open only so a caller that already knows a connection
  // id can name it: the api_call tool has no way to address a member of a set,
  // which is why a remote run binds one connection per integration (run-creation).
  "x-run-id",
]);

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
interface LocalIntegrationCredentialsFile {
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

/**
 * Creds-file load gate — the local-path twin of the integration manifest
 * validator's rule (1d) (`@appstrate/core/integration`).
 *
 * `injection.headerPrefix` is hand-authored in the creds file and reaches the
 * injector without ever passing through a manifest, so the install-time gate
 * cannot see it and this is the only place the defect can be caught. Refusing
 * the whole file when it is read — before a single tool is built, let alone
 * called — puts the error where the operator can still edit the file, rather
 * than in an upstream 401 mid-run that names nothing.
 *
 * Returns `creds` so both materialisation points (parsed object in the
 * constructor, JSON file in {@link LocalIntegrationResolver.loadCreds}) gate in
 * one expression.
 */
function assertUsableCredsFile(
  creds: LocalIntegrationCredentialsFile,
): LocalIntegrationCredentialsFile {
  for (const [name, entry] of Object.entries(creds.integrations)) {
    const prefix = entry.injection?.headerPrefix;
    // The default mirrors `resolveLocalDeliveryPlan`'s: an override that names
    // no header lands in Authorization position, where a bare scheme is a
    // defect.
    const headerName = entry.injection?.headerName ?? "Authorization";
    if (typeof prefix === "string" && isBareAuthSchemePrefix(headerName, prefix)) {
      throw new Error(
        `LocalIntegrationResolver: integrations["${name}"].injection.headerPrefix "${prefix}" is a bare auth scheme — the prefix is a literal (AFPS §7.6) and is concatenated verbatim, so it must include its own separator. Write "${prefix} ".`,
      );
    }
  }
  return creds;
}

interface LocalIntegrationResolverOptions {
  /** Path to a creds JSON file or an already-parsed object. */
  creds: string | LocalIntegrationCredentialsFile;
  /** Transport override (tests) — disables the address pin. Omitted = pinned global `fetch`. */
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
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolveHost: HostResolver | undefined;
  private creds: LocalIntegrationCredentialsFile | null;
  private readonly credsPath: string | null;

  constructor(opts: LocalIntegrationResolverOptions) {
    this.fetchImpl = opts.fetch;
    this.resolveHost = opts.resolveHost;
    if (typeof opts.creds === "string") {
      this.creds = null;
      this.credsPath = opts.creds;
    } else {
      this.creds = assertUsableCredsFile(opts.creds);
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
          makeApiCallTool(meta, this.buildCall(meta, entry), {
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
    this.creds = assertUsableCredsFile(JSON.parse(raw) as LocalIntegrationCredentialsFile);
    return this.creds;
  }

  private buildCall(
    meta: ApiCallIntegrationMeta,
    entry: LocalIntegrationCredentialsFile["integrations"][string],
  ): ApiCallFn {
    // Matching uses the list rendered for this connection; the SSRF pin and cookie
    // siblings use the declared one, so a connection-supplied host is never trusted.
    const authorizedUris = renderAuthorizedUris(meta.authorizedUris, entry.fields);
    return async (req, ctx) => {
      const fields = entry.fields;

      const deliveryPlan = resolveLocalDeliveryPlan(meta, entry);
      const allowsAuthorizationOverride =
        deliveryPlan?.allowServerOverride === true &&
        deliveryPlan.headerName.toLowerCase() === "authorization";

      // Strip Appstrate transport headers before substitution. Authorization
      // survives on this LOCAL path only when the delivery plan targets that
      // header and explicitly authorises a caller override. The remote resolver
      // always strips it because it authenticates to Appstrate with that header.
      const callerHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        const lowerKey = key.toLowerCase();
        if (
          RESERVED_TRANSPORT_HEADERS.has(lowerKey) &&
          !(lowerKey === "authorization" && allowsAuthorizationOverride)
        ) {
          continue;
        }
        callerHeaders[key] = value;
      }
      // A string body is the only one substituted (never multipart).
      const prepared = prepareApiCallRequest({
        target: req.target,
        headers: callerHeaders,
        bodyTemplates: typeof req.body === "string" ? [req.body] : [],
        fields,
      });
      if (!prepared.ok) {
        const { kind, message } = prepared.refusal;
        if (kind === "invalid_header") throw headerInvalid(meta.name, message);
        throw new ResolverError("RESOLVER_BODY_INVALID", `Integration ${meta.name}: ${message}`, {
          integration: meta.name,
        });
      }
      const { url: target, headers, credentialHeaders, templates } = prepared.request;
      // Inject the credential header locally and capture its name so the
      // shared engine's redirect-follower knows which header to strip on
      // an out-of-boundary cross-origin hop.
      const injectedCredentialHeader = deliveryPlan
        ? applyDeliveryPlan(headers, deliveryPlan)
        : null;

      const policy = credentialUrlPolicy({
        templates,
        fields,
        allowAllUris: meta.allowAllUris,
        declaredUris: meta.authorizedUris,
        authorizedUris,
        injectsCredential: injectedCredentialHeader !== null,
      });
      if (policy.refuse) {
        throw apiCallFailure(
          URL_POLICY_REFUSAL_CODE[policy.refuse],
          urlPolicyRefusalMessage(policy.refuse, meta.name),
          meta,
          req.target,
        );
      }
      const redactFields = redactionFields(policy, fields);

      const resolvedBody = await resolveBodyForFetch(req.body, {
        allowFromFile: true,
        workspace: ctx.workspace,
        transformString: (input) => substituteVars(input, fields),
      });

      if (resolvedBody.kind === "bytes" && resolvedBody.contentType) {
        // A caller's spelling of the header would survive beside ours: the boundary must be ours.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-type") delete headers[key];
        }
        headers["Content-Type"] = resolvedBody.contentType;
      }

      const init: RequestInit & Record<string, unknown> = {
        method: req.method,
        headers,
        body: resolvedBody.kind === "bytes" ? resolvedBody.bytes : resolvedBody.stream,
        signal: ctx.signal,
      };
      if (resolvedBody.kind === "stream") init.duplex = "half";

      let res: Response;
      try {
        const result = await fetchApiCall({
          url: target,
          init,
          authorizedUris,
          declaredUris: meta.authorizedUris,
          allowAllUris: policy.allowAllUris,
          credentialHeaders: injectedCredentialHeader
            ? [...credentialHeaders, injectedCredentialHeader]
            : credentialHeaders,
          // The caller's own machine and network: a host the manifest names literally is theirs.
          internalHost: () => true,
          integrationId: meta.name,
          ...(this.fetchImpl ? { fetchFn: this.fetchImpl } : {}),
          ...(this.resolveHost ? { resolveHost: this.resolveHost } : {}),
          targetHost: templateHost(req.target),
          credentialFields: redactFields,
        });
        res = result.response;
      } catch (err) {
        // The caller cancelled: its own abort, not an outcome of the call.
        if (ctx.signal?.aborted) throw err;
        // No `cause`: Bun's error keeps the full URL (a redirect's `?token=…`) on `.path`.
        const { code, message, redirect, systemCode } = classifyApiCallFailure(err);
        throw apiCallFailure(code, `Integration ${meta.name}: ${message}`, meta, req.target, {
          redirect,
          ...(systemCode ? { systemCode } : {}),
        });
      }

      return serializeFetchResponse(res, {
        workspace: ctx.workspace,
        toolCallId: ctx.toolCallId,
        ...(req.responseMode ? { responseMode: req.responseMode } : {}),
      });
    };
  }
}

/** An outbound failure or URL-policy refusal: the target as written, the allowlist as declared. */
function apiCallFailure(
  code: ApiCallFailureCode,
  message: string,
  meta: ApiCallIntegrationMeta,
  target: string,
  extra: Record<string, unknown> = {},
): ApiCallFailureError {
  return new ApiCallFailureError(code, message, {
    integration: meta.name,
    target,
    allowlist: meta.authorizedUris,
    ...extra,
  });
}

/** An agent header value that is no HTTP field value (the message names the header only). */
function headerInvalid(integration: string, message: string): ResolverError {
  return new ResolverError("RESOLVER_HEADER_INVALID", `Integration ${integration}: ${message}`, {
    integration,
  });
}

/**
 * Resolve the local credential-delivery plan. Precedence:
 *   1. explicit `entry.injection` override (header name/prefix + template),
 *   2. the integration manifest's `delivery.http` plan (auth-type defaults
 *      applied) — mirrors `@appstrate/connect`'s `resolveHttpDelivery`.
 *
 * When neither yields a header (e.g. `custom` auth with no `delivery.http`),
 * returns `null` and the caller injects nothing.
 *
 * Both prefixes are concatenated verbatim downstream and neither is inspected
 * here: the override's was gated by {@link assertUsableCredsFile} when the file
 * was read, the manifest's by the install-time validator.
 */
function resolveLocalDeliveryPlan(
  meta: ApiCallIntegrationMeta,
  entry: LocalIntegrationCredentialsFile["integrations"][string],
): HttpDeliveryPlan | null {
  const fields = entry.fields;

  // 1. Explicit override from the creds file.
  if (entry.injection) {
    const rendered = entry.injection.template
      ? substituteVars(entry.injection.template, fields)
      : (fields.api_key ?? fields.access_token);
    if (!rendered) return null;
    const headerName = entry.injection.headerName ?? "Authorization";
    const headerPrefix = entry.injection.headerPrefix ?? "";
    return {
      headerName,
      headerPrefix,
      value: rendered,
      allowServerOverride: false,
    };
  }

  // 2. Manifest `delivery.http` plan (auth-type defaults).
  return resolveHttpDelivery(meta.authType, fields, meta.http);
}

function applyDeliveryPlan(headers: Record<string, string>, plan: HttpDeliveryPlan): string | null {
  const decision = planHttpDeliveryInjection(plan, Object.keys(headers));
  if (decision.kind === "none") return null;
  if (decision.kind === "caller_override") return decision.headerName;

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === decision.header.name.toLowerCase()) delete headers[key];
  }
  headers[decision.header.name] = decision.header.value;
  return decision.header.name;
}

// ─────────────────────────────────────────────
// Remote resolver
// ─────────────────────────────────────────────

interface RemoteAppstrateIntegrationResolverOptions {
  /** Base URL of the Appstrate instance. */
  instance: string;
  /** API key (apst_...) or device-flow JWT with `credential-proxy:call`. */
  apiKey: string;
  /** Space id (spc_...) the caller is scoped to. */
  spaceId: string;
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
  private readonly spaceId: string;
  private readonly orgId: string | undefined;
  private readonly endUserId: string | undefined;
  private readonly sessionId: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RemoteAppstrateIntegrationResolverOptions) {
    if (!opts.instance) throw new Error("RemoteAppstrateIntegrationResolver: instance is required");
    if (!opts.apiKey) throw new Error("RemoteAppstrateIntegrationResolver: apiKey is required");
    if (!opts.spaceId) throw new Error("RemoteAppstrateIntegrationResolver: spaceId is required");
    this.instance = opts.instance.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.spaceId = opts.spaceId;
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
        tools.push(
          makeApiCallTool(meta, this.buildCall(meta), {
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
      // The caller-header rule of `fetchApiCall`, then the reserved transport headers; the
      // platform-controlled ones are set over what remains.
      let agentHeaders: Headers;
      try {
        agentHeaders = forwardableHeaders({ headers: req.headers });
      } catch (err) {
        if (err instanceof InvalidHeaderValueError) throw headerInvalid(meta.name, err.message);
        throw err;
      }
      for (const name of RESERVED_TRANSPORT_HEADERS) agentHeaders.delete(name);
      const platformHeaders: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "X-Space-Id": this.spaceId,
        ...(this.orgId ? { "X-Org-Id": this.orgId } : {}),
        "X-Session-Id": this.sessionId,
        "X-Integration-Id": meta.name,
        "X-Target": req.target,
        ...(this.endUserId ? { "Appstrate-User": this.endUserId } : {}),
        ...this.extraHeaders,
      };
      const wantsFile = typeof req.responseMode?.toFile === "string";

      const send = async (): Promise<Response> => {
        const resolved = await resolveBodyForFetch(req.body, {
          allowFromFile: true,
          allowStreaming: true,
          workspace: ctx.workspace,
        });
        const headers = new Headers(agentHeaders);
        for (const [name, value] of Object.entries(platformHeaders)) headers.set(name, value);
        const isStreamingBody = resolved.kind === "stream";
        applyTransportHeaders(headers, {
          wantsFile,
          isStreamingBody,
          bodySize: isStreamingBody ? resolved.size : undefined,
          maxInlineBytes: req.responseMode?.maxInlineBytes,
        });
        if (resolved.kind === "bytes" && resolved.contentType) {
          headers.set("Content-Type", resolved.contentType);
        }
        const init: RequestInit & Record<string, unknown> = {
          method: req.method,
          headers,
          signal: ctx.signal,
          body: isStreamingBody ? resolved.stream : resolved.bytes,
        };
        if (isStreamingBody) init.duplex = "half";
        return this.fetchImpl(`${this.instance}/api/credential-proxy/proxy`, init);
      };

      let res = await send();
      if (
        res.status === 401 &&
        res.headers.get("x-auth-refreshed") === "true" &&
        isReproducibleBody(req.body)
      ) {
        res = await send();
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
