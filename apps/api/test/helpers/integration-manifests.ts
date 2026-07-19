// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration-manifest builders for tests.
 *
 * After the AFPS migration the integration manifest is snake_case with a
 * `source` discriminant (`local` | `remote` | `none`), per-auth `delivery.http`
 * value templates (`{$credential.<field>}`), `authorized_uris`, and OAuth
 * endpoint fields (`authorization_endpoint`, `token_endpoint`, `default_scopes`,
 * …). These builders centralise the new shape so the integration / credential /
 * connect test suites don't each re-declare it. Returns `IntegrationManifest`.
 */

import type { IntegrationManifest } from "@appstrate/core/integration";

/** AFPS `delivery.http` header block with a `{$credential.<field>}` value template. */
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

/** AFPS `delivery.env` map with `{$credential.<field>}` value templates. */
export function envDelivery(entries: Record<string, string>): {
  env: Record<string, { value: string }>;
} {
  const env: Record<string, { value: string }> = {};
  for (const [k, field] of Object.entries(entries)) env[k] = { value: `{$credential.${field}}` };
  return { env };
}

/**
 * AFPS §7.6 `delivery.env` map with `user_config_key` bridge — exercises
 * the CC-4 substitution path where a local-source integration's env var also
 * flows into the referenced mcp-server's `mcp_config.env` template via
 * `${user_config.<key>}`. Each entry: `{ envVar: { field, userConfigKey } }`.
 */
export function envDeliveryWithUserConfigKey(
  entries: Record<string, { field: string; userConfigKey?: string }>,
): { env: Record<string, { value: string; user_config_key?: string }> } {
  const env: Record<string, { value: string; user_config_key?: string }> = {};
  for (const [k, conf] of Object.entries(entries)) {
    env[k] = {
      value: `{$credential.${conf.field}}`,
      ...(conf.userConfigKey ? { user_config_key: conf.userConfigKey } : {}),
    };
  }
  return { env };
}

/**
 * AFPS §7.6 `delivery.files` map — entries are
 * `{ absolutePath: { credentialField, mode? } }`. The value template uses the
 * standard `{$credential.<field>}` grammar so the spawn resolver renders the
 * file body from the decrypted credential bag. Used by mtls integrations
 * (cert + key) and any custom file-shaped auth.
 */
export function filesDelivery(entries: Record<string, { field: string; mode?: string }>): {
  files: Record<string, { value: string; mode?: string }>;
} {
  const files: Record<string, { value: string; mode?: string }> = {};
  for (const [path, conf] of Object.entries(entries)) {
    files[path] = {
      value: `{$credential.${conf.field}}`,
      ...(conf.mode !== undefined ? { mode: conf.mode } : {}),
    };
  }
  return { files };
}

interface AuthSpec {
  type: "oauth2" | "api_key" | "basic" | "custom" | "mtls";
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
    // `default_scopes` is OPTIONAL on non-oauth2 auths (the field is purely
    // informational there — no consent step), but the integration schema
    // accepts it. Forward it so tests can use a non-oauth2 auth with
    // `allow_undeclared_tools: true` (which requires non-empty default_scopes).
    if (spec.defaultScopes) auth.default_scopes = spec.defaultScopes;
  }
  if (spec.connect) auth.connect = spec.connect;
  auth.delivery =
    spec.delivery ??
    httpHeaderDelivery({ name: "Authorization", prefix: "Bearer ", field: "api_key" });
  return auth;
}

/**
 * Build an AFPS integration manifest with a `local` source (referencing an
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
  tools_policy?: Record<
    string,
    {
      required_scopes?: Record<string, string[]>;
    }
  >;
  /** AFPS §7.8 opt-in — when true, agents MAY set `tools: "*"`. */
  allow_undeclared_tools?: boolean;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  return {
    type: "integration",
    schema_version: "0.1",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    source: {
      kind: "local",
      server: { name: opts.serverName ?? opts.name, version: `^${version}` },
    },
    auths,
    ...(opts.tools_policy ? { tools_policy: opts.tools_policy } : {}),
    ...(opts.allow_undeclared_tools === true ? { allow_undeclared_tools: true } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * Build an AFPS integration manifest with a `remote` source (Streamable
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
  tools_policy?: Record<string, unknown>;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  const withRemote = opts.withRemote ?? true;
  return {
    type: "integration",
    schema_version: "0.1",
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
    ...(opts.tools_policy ? { tools_policy: opts.tools_policy } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * Build a serverless AFPS integration manifest (`source.kind: "none"` — no MCP
 * server to spawn). When `apiCall` is set, the integration opts the named auth
 * into the `api_call` vendor capability via the `_meta["dev.appstrate/api"]`
 * extension (orthogonal to `source.kind`). `apiCall.authKey` MUST be a key that
 * also exists in `auths`. `apiCall.uploadProtocols` carries the resumable-upload
 * protocols that auth advertises.
 */
export function apiIntegrationManifest(opts: {
  name: string;
  version?: string;
  displayName?: string;
  /** Opt an auth into the `api_call` tool via `_meta["dev.appstrate/api"]`. */
  apiCall?: { authKey: string; uploadProtocols?: string[] };
  /** AFPS §4.4 — tools an agent inherits when it omits `integrations_configuration.<id>`. */
  defaultTools?: string[] | "*";
  auths: Record<string, AuthSpec>;
  tools_policy?: Record<string, unknown>;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(opts.auths)) auths[k] = buildAuth(spec);
  const meta = opts.apiCall
    ? {
        _meta: {
          "dev.appstrate/api": {
            auths: {
              [opts.apiCall.authKey]: opts.apiCall.uploadProtocols
                ? { upload_protocols: opts.apiCall.uploadProtocols }
                : {},
            },
          },
        },
      }
    : {};
  return {
    type: "integration",
    schema_version: "0.1",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    source: { kind: "none" },
    ...(opts.defaultTools ? { default_tools: opts.defaultTools } : {}),
    ...meta,
    auths,
    ...(opts.tools_policy ? { tools_policy: opts.tools_policy } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * AFPS orchestrated `connect.tool` block: the marker object `{}` plus the
 * Appstrate run-policy fields (`tool`, `run_at`, `produces`, `persist_login_secret`,
 * `reauth_on`) under `_meta["dev.appstrate/connect"]`.
 */
export function connectToolBlock(opts: {
  tool: string;
  runAt?: "link" | "run-start";
  produces?: string[];
  persistLoginSecret?: boolean;
  reauthOn?: number[];
  browserExecutor?: { sessionMode: "exportable" | "browser-bound" };
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { tool: opts.tool };
  if (opts.runAt !== undefined) meta.run_at = opts.runAt;
  if (opts.produces !== undefined) meta.produces = opts.produces;
  if (opts.persistLoginSecret !== undefined) meta.persist_login_secret = opts.persistLoginSecret;
  if (opts.reauthOn !== undefined) meta.reauth_on = opts.reauthOn;
  if (opts.browserExecutor !== undefined) {
    meta.executor = { kind: "browser", session_mode: opts.browserExecutor.sessionMode };
  }
  return { tool: {}, _meta: { "dev.appstrate/connect": meta } };
}

/**
 * AFPS declarative `connect.login` block. `outputs` values are Arazzo
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

/** Build a minimal AFPS mcp-server (MCPB) manifest for the local-source path. */
export function mcpServerManifest(opts: {
  /**
   * Scoped AFPS identity at the manifest root (AFPS §3.4 lifted it from
   * `_meta["dev.afps/mcp-server"].name`). Must follow `@scope/name`.
   */
  name: string;
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
  /**
   * MCPB `server.mcp_config.env` map — typically literal strings or
   * `"${user_config.<key>}"` placeholders. Used to exercise the AFPS
   * §7.6 `user_config_key` substitution path (CC-4) — the integration's
   * `delivery.env.<var>.user_config_key` names the placeholder key here.
   */
  mcpConfigEnv?: Record<string, string>;
  /**
   * Shared-workspace opt-in (`_meta["dev.appstrate/workspace"]`).
   * When set, the spawn resolver populates
   * `IntegrationSpawnSpec.workspaceMount` from this declaration; the
   * sidecar then mounts the per-run shared workspace into the runner
   * (Docker volume in tier 3, host directory in tier 0-2).
   */
  workspace?: { mount?: string; access?: "ro" | "rw" };
}): Record<string, unknown> {
  const type = opts.serverType ?? "node";
  const entryPoint = opts.entryPoint ?? "main.js";
  const mcpConfig: Record<string, unknown> = {
    command: type === "node" ? "node" : "python3",
    args: [entryPoint],
  };
  if (opts.mcpConfigEnv) mcpConfig.env = opts.mcpConfigEnv;
  const manifest: Record<string, unknown> = {
    manifest_version: "0.3",
    name: opts.name,
    version: opts.version ?? "1.0.0",
    type: "mcp-server",
    schema_version: "0.1",
    display_name: opts.name,
    server: {
      type,
      entry_point: entryPoint,
      mcp_config: mcpConfig,
    },
  };
  const meta: Record<string, unknown> = {};
  if (opts.appstrateRuntime) {
    meta["dev.appstrate/mcp-server"] = { runtime: opts.appstrateRuntime };
  }
  if (opts.workspace) {
    meta["dev.appstrate/workspace"] = opts.workspace;
  }
  if (Object.keys(meta).length > 0) manifest._meta = meta;
  return manifest;
}
