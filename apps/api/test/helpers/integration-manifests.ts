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
export function httpHeaderDelivery(opts: {
  name: string;
  prefix?: string;
  field: string;
  allowServerOverride?: boolean;
}): {
  http: {
    in: "header";
    name: string;
    prefix?: string;
    value: string;
    allow_server_override?: boolean;
  };
} {
  return {
    http: {
      in: "header",
      name: opts.name,
      ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
      value: `{$credential.${opts.field}}`,
      ...(opts.allowServerOverride ? { allow_server_override: true } : {}),
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
  /** AFPS `authorization_params` — extra static query params on the authorize URL. */
  authorizationParams?: Record<string, string>;
  /** `_meta["dev.appstrate/oauth"].refresh_token_issuance` — provider refresh behaviour. */
  refreshTokenIssuance?: "default" | "not_supported";
  resource?: string;
  codeChallengeMethodsSupported?: string[];
  scopeSeparator?: string;
  identityClaims?: Record<string, string>;
  // credentials schema (api_key/basic/custom)
  credentialFields?: string[];
  /** `credentials.schema.required` — needed by fields an `authorized_uris` template references. */
  requiredCredentialFields?: string[];
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
    if (spec.authorizationParams) auth.authorization_params = spec.authorizationParams;
    if (spec.resource) auth.resource = spec.resource;
    if (spec.codeChallengeMethodsSupported)
      auth.code_challenge_methods_supported = spec.codeChallengeMethodsSupported;
    if (spec.identityClaims) auth.identity_claims = spec.identityClaims;
    const oauthMeta: Record<string, unknown> = {
      ...(spec.scopeSeparator ? { scope_separator: spec.scopeSeparator } : {}),
      ...(spec.refreshTokenIssuance ? { refresh_token_issuance: spec.refreshTokenIssuance } : {}),
    };
    if (Object.keys(oauthMeta).length > 0) {
      auth._meta = { "dev.appstrate/oauth": oauthMeta };
    }
  } else {
    auth.credentials = {
      schema: {
        type: "object",
        properties: Object.fromEntries(
          (spec.credentialFields ?? ["api_key"]).map((f) => [f, { type: "string" }]),
        ),
        ...(spec.requiredCredentialFields ? { required: spec.requiredCredentialFields } : {}),
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

/** The inline `source.server` of a local integration, in builder terms. */
export interface LocalServerSpec {
  type?: "node" | "python" | "binary" | "uv";
  /** Path inside the integration archive. Defaults to `server/index.js`. */
  entryPoint?: string;
  /** Literal `mcp_config.env` entries, merged into the runner env under `delivery.env`. */
  env?: Record<string, string>;
  /** Advisory `source.server.tools` catalog. */
  tools?: Array<{ name: string; description?: string }>;
  /**
   * Appstrate runtime override → `_meta["dev.appstrate/mcp-server"].runtime`. AFPS has no `bun`
   * server type, so a bun-native server keeps a valid `type` and declares the real runtime here.
   */
  appstrateRuntime?: string;
  /**
   * Shared-workspace opt-in (`_meta["dev.appstrate/workspace"]`): the spawn resolver populates
   * `IntegrationSpawnSpec.workspaceMount` from it.
   */
  workspace?: { mount?: string; access?: "ro" | "rw" };
}

/**
 * Build an AFPS integration manifest with a `local` source declaring its MCP
 * server inline (`source.server`) and the given auths.
 */
export function localIntegrationManifest(opts: {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  /** The inline server declaration; defaults to a node server at `server/index.js`. */
  server?: LocalServerSpec;
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
  const server = opts.server ?? {};
  const type = server.type ?? "node";
  const entryPoint = server.entryPoint ?? "server/index.js";
  const meta: Record<string, unknown> = {};
  if (server.appstrateRuntime) {
    meta["dev.appstrate/mcp-server"] = { runtime: server.appstrateRuntime };
  }
  if (server.workspace) meta["dev.appstrate/workspace"] = server.workspace;
  return {
    type: "integration",
    schema_version: "0.1",
    name: opts.name,
    version,
    display_name: opts.displayName ?? opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    source: {
      kind: "local",
      server: {
        type,
        entry_point: entryPoint,
        mcp_config: {
          command: type === "node" ? "node" : "python3",
          args: [entryPoint],
          ...(server.env ? { env: server.env } : {}),
        },
        ...(server.tools ? { tools: server.tools } : {}),
      },
    },
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
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
  /** Omitted: an unauthenticated integration (AFPS §7.2), with no `auths` at all. */
  auths?: Record<string, AuthSpec>;
  tools_policy?: Record<string, unknown>;
}): IntegrationManifest {
  const version = opts.version ?? "1.0.0";
  const auths = opts.auths
    ? Object.fromEntries(Object.entries(opts.auths).map(([k, spec]) => [k, buildAuth(spec)]))
    : undefined;
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
    ...(auths ? { auths } : {}),
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
    ...(auths ? { auths } : {}),
    ...(opts.tools_policy ? { tools_policy: opts.tools_policy } : {}),
  } as unknown as IntegrationManifest;
}

/**
 * An `api_call` integration whose two api_key auths, `primary` and `backup`, both expose `api_call`:
 * an agent selecting `api_call__primary` is served by a `primary` connection only.
 */
export function twoAuthApiIntegrationManifest(
  name: string,
  authorizedUris = { primary: "https://api.example.com/**", backup: "https://api.example.com/**" },
): IntegrationManifest {
  const auth = (uri: string) => ({ type: "api_key" as const, authorizedUris: [uri] });
  return {
    ...apiIntegrationManifest({
      name,
      auths: { primary: auth(authorizedUris.primary), backup: auth(authorizedUris.backup) },
    }),
    _meta: { "dev.appstrate/api": { auths: { primary: {}, backup: {} } } },
  } as IntegrationManifest;
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
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { tool: opts.tool };
  if (opts.runAt !== undefined) meta.run_at = opts.runAt;
  if (opts.produces !== undefined) meta.produces = opts.produces;
  if (opts.persistLoginSecret !== undefined) meta.persist_login_secret = opts.persistLoginSecret;
  if (opts.reauthOn !== undefined) meta.reauth_on = opts.reauthOn;
  return { tool: {}, _meta: { "dev.appstrate/connect": meta } };
}
