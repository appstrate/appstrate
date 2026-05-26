// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 integration-manifest builders for tests.
 *
 * After the AFPS 2.0 migration the integration manifest is snake_case with a
 * `source` discriminant (`local` | `remote` | `api`), per-auth `delivery.http`
 * value templates (`{$credential.<field>}`), `authorized_uris`, and OAuth
 * endpoint fields (`authorization_endpoint`, `token_endpoint`, `default_scopes`,
 * …). These builders centralise the new shape so the integration / credential /
 * connect test suites don't each re-declare it. Returns `IntegrationManifest`.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";

/** AFPS 2.0 `delivery.http` header block with a `{$credential.<field>}` value template. */
export function httpHeaderDelivery(opts: { name: string; prefix?: string; field: string }): {
  http: { in: "header"; name: string; prefix?: string; value: string };
} {
  return {
    http: {
      in: "header",
      name: opts.name,
      ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
      value: `{$credential.${opts.field}}`,
    },
  };
}

/** AFPS 2.0 `delivery.env` map with `{$credential.<field>}` value templates. */
export function envDelivery(entries: Record<string, string>): {
  env: Record<string, { value: string }>;
} {
  const env: Record<string, { value: string }> = {};
  for (const [k, field] of Object.entries(entries)) env[k] = { value: `{$credential.${field}}` };
  return { env };
}

interface AuthSpec {
  type: "oauth2" | "api_key" | "basic" | "custom";
  authorizedUris?: string[];
  allowAllUris?: boolean;
  // oauth2
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  issuer?: string;
  defaultScopes?: string[];
  scopeCatalog?: Array<{ value: string; label: string; implies?: string[] }>;
  tokenEndpointAuthMethod?: "client_secret_post" | "client_secret_basic" | "none";
  resource?: string;
  codeChallengeMethodsSupported?: string[];
  scopeSeparator?: string;
  identityClaims?: Record<string, string>;
  // credentials schema (api_key/basic/custom)
  credentialFields?: string[];
  // delivery
  delivery?: Record<string, unknown>;
  // connect (custom)
  connect?: Record<string, unknown>;
}

function buildAuth(spec: AuthSpec): Record<string, unknown> {
  const auth: Record<string, unknown> = {
    type: spec.type,
    authorized_uris: spec.authorizedUris ?? ["https://api.example.com/**"],
    ...(spec.allowAllUris !== undefined ? { allow_all_uris: spec.allowAllUris } : {}),
  };
  if (spec.type === "oauth2") {
    if (spec.issuer) auth.issuer = spec.issuer;
    if (spec.authorizationEndpoint) auth.authorization_endpoint = spec.authorizationEndpoint;
    if (spec.tokenEndpoint) auth.token_endpoint = spec.tokenEndpoint;
    if (spec.defaultScopes) auth.default_scopes = spec.defaultScopes;
    if (spec.scopeCatalog) auth.scope_catalog = spec.scopeCatalog;
    if (spec.tokenEndpointAuthMethod)
      auth.token_endpoint_auth_method = spec.tokenEndpointAuthMethod;
    if (spec.resource) auth.resource = spec.resource;
    if (spec.codeChallengeMethodsSupported)
      auth.code_challenge_methods_supported = spec.codeChallengeMethodsSupported;
    if (spec.identityClaims) auth.identity_claims = spec.identityClaims;
    if (spec.scopeSeparator) {
      auth._meta = { "dev.appstrate/oauth": { scope_separator: spec.scopeSeparator } };
    }
  } else {
    auth.credentials = {
      schema: {
        type: "object",
        properties: Object.fromEntries(
          (spec.credentialFields ?? ["api_key"]).map((f) => [f, { type: "string" }]),
        ),
      },
    };
  }
  if (spec.connect) auth.connect = spec.connect;
  auth.delivery =
    spec.delivery ??
    httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" });
  return auth;
}

/**
 * Build an AFPS 2.0 integration manifest with a `local` source (referencing an
 * mcp-server package of the same name) and the given auths.
 */
export function localIntegrationManifest(opts: {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  /** Scoped name of the referenced mcp-server package (`source.server.name`). Defaults to `name`. */
  serverName?: string;
  auths: Record<string, AuthSpec>;
  tools?: Record<
    string,
    {
      required_scopes?: string[];
      required_auth_key?: string;
      url_patterns?: Array<{ pattern: string; methods?: string[] }>;
    }
  >;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  return {
    type: "integration",
    schema_version: "2.0",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    source: {
      kind: "local",
      server: { name: opts.serverName ?? opts.name, version: `^${version}` },
    },
    auths,
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * Build an AFPS 2.0 integration manifest with a `remote` source (Streamable
 * HTTP MCP). `source.remote = { url, transport }`; the sidecar opens an HTTP
 * MCP client rather than spawning a runner.
 */
export function remoteIntegrationManifest(opts: {
  name: string;
  version?: string;
  displayName?: string;
  url?: string;
  transport?: string;
  /** When false, omit `source.remote` to exercise the missing-url guard. */
  withRemote?: boolean;
  auths: Record<string, AuthSpec>;
  tools?: Record<string, unknown>;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  const withRemote = opts.withRemote ?? true;
  return {
    type: "integration",
    schema_version: "2.0",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    source: {
      kind: "remote",
      ...(withRemote
        ? {
            remote: {
              url: opts.url ?? "https://mcp.example.com/mcp/v1",
              transport: opts.transport ?? "streamable-http",
            },
          }
        : {}),
    },
    auths,
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as unknown as IntegrationManifest;
}

/** Build an AFPS 2.0 integration manifest with a serverless `api` source. */
export function apiIntegrationManifest(opts: {
  name: string;
  version?: string;
  displayName?: string;
  uploadProtocols?: string[];
  auths: Record<string, AuthSpec>;
  tools?: Record<string, unknown>;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  return {
    type: "integration",
    schema_version: "2.0",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    source: {
      kind: "api",
      api: opts.uploadProtocols ? { upload_protocols: opts.uploadProtocols } : {},
    },
    auths,
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * AFPS 2.0 orchestrated `connect.tool` block: the marker object `{}` plus the
 * Appstrate run-policy fields (`tool`, `run_at`, `produces`, `persist_login_secret`,
 * `reauth_on`) under `_meta["dev.appstrate/connect"]`.
 */
export function connectToolBlock(opts: {
  tool: string;
  runAt?: "link" | "run-start";
  produces?: string[];
  persistLoginSecret?: boolean;
  reauthOn?: number[];
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { tool: opts.tool };
  if (opts.runAt !== undefined) meta.run_at = opts.runAt;
  if (opts.produces !== undefined) meta.produces = opts.produces;
  if (opts.persistLoginSecret !== undefined) meta.persist_login_secret = opts.persistLoginSecret;
  if (opts.reauthOn !== undefined) meta.reauth_on = opts.reauthOn;
  return { tool: {}, _meta: { "dev.appstrate/connect": meta } };
}

/**
 * AFPS 2.0 declarative `connect.login` block. `outputs` values are Arazzo
 * runtime-expression strings or extractor objects; `success_criteria` is the
 * Arazzo criterion array (was the 1.x `okStatus`).
 */
export function connectLoginBlock(opts: {
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    content_type?: string;
  };
  successCriteria?: Array<{ condition: string }>;
  outputs: Record<string, unknown>;
  expiresInOutput?: string;
  identityOutputs?: string[];
}): Record<string, unknown> {
  const login: Record<string, unknown> = { request: opts.request, outputs: opts.outputs };
  if (opts.successCriteria) login.success_criteria = opts.successCriteria;
  if (opts.expiresInOutput) login.expires_in_output = opts.expiresInOutput;
  if (opts.identityOutputs) login.identity_outputs = opts.identityOutputs;
  return { login };
}

/** Build a minimal AFPS 2.0 mcp-server (MCPB) manifest for the local-source path. */
export function mcpServerManifest(opts: {
  /** Verbatim MCPB top-level `name` (unscoped by convention). */
  name: string;
  /**
   * Scoped AFPS identity for `_meta["dev.afps/mcp-server"].name`. Real MCPB
   * manifests keep the top-level `name` unscoped and carry the scoped id here;
   * the platform derives the package id from this. Defaults to `name`.
   */
  afpsName?: string;
  version?: string;
  serverType?: "node" | "python" | "binary" | "uv";
  entryPoint?: string;
  /**
   * Appstrate runtime override → `_meta["dev.appstrate/mcp-server"].runtime`.
   * MCPB has no `bun` server.type, so a bun-native server keeps an MCPB-valid
   * `serverType` and declares the real runtime here. Server-side only — never
   * belongs on the integration manifest.
   */
  appstrateRuntime?: string;
}): Record<string, unknown> {
  const type = opts.serverType ?? "node";
  const entryPoint = opts.entryPoint ?? "main.js";
  const meta: Record<string, unknown> = {
    "dev.afps/mcp-server": { name: opts.afpsName ?? opts.name, type: "mcp-server" },
  };
  if (opts.appstrateRuntime) {
    meta["dev.appstrate/mcp-server"] = { runtime: opts.appstrateRuntime };
  }
  return {
    manifest_version: "0.3",
    name: opts.name,
    version: opts.version ?? "1.0.0",
    display_name: opts.name,
    server: {
      type,
      entry_point: entryPoint,
      mcp_config: { command: type === "node" ? "node" : "python3", args: [entryPoint] },
    },
    _meta: meta,
  };
}
