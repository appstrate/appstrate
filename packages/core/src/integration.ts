// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS Integration manifest — Zod schema and TypeScript types.
 *
 * Implements §4.1.1 of `docs/architecture/INTEGRATIONS_PROPOSAL.md`
 * (Phase 1.0). The runtime side (spawn, credential proxy, MCP Router)
 * lives downstream in Phase 1.2a; this module only validates the
 * manifest shape so bundles can be imported into the DB.
 *
 * The schema is intentionally local to `@appstrate/core` rather than
 * upstreamed to `@afps-spec/schema` for Phase 1.0 — it can be promoted
 * once the AFPS spec itself is amended (proposal §4.3). Keeping it
 * here avoids requiring an afps-spec release for every Appstrate-side
 * iteration on Phase 1.x.
 */

import { z } from "zod";
import { SLUG_PATTERN } from "./naming.ts";
import type { ManifestIntegrationEntry } from "./dependencies.ts";

// Local copy to avoid a circular import with `./validation.ts`.
// Equivalent to `scopedNameRegex` exported from validation.ts.
const scopedNameRegex = new RegExp(`^@${SLUG_PATTERN}\\/${SLUG_PATTERN}$`);

// `manifestVersion` mirrors MCPB (`1.0` / `1.1`). Allow any 1.x.
const manifestVersionRegex = /^1\.(0|[1-9]\d*)$/;

/**
 * Resumable-upload protocols an integration's generic `apiCall` tool can
 * advertise — ported from the legacy `provider` `uploadProtocols`
 * (AFPS v1 §7.7). Declared locally rather than imported from
 * `./validation.ts` to preserve this module's circular-import guard.
 */
export const integrationUploadProtocolEnum = z.enum([
  "google-resumable",
  "s3-multipart",
  "tus",
  "ms-resumable",
]);

export type IntegrationUploadProtocol = z.infer<typeof integrationUploadProtocolEnum>;

// ─────────────────────────────────────────────
// Server runtime — closed enum + author sugars
// ─────────────────────────────────────────────

/**
 * Runtime server types accepted in a published integration manifest.
 * `npx` / `uvx` are author-time sugars that the AFPS bundler converts
 * to `node` / `uv` before publish (proposal D31, §4.1.2). They are
 * accepted here so authoring CLIs can validate pre-bundle manifests.
 */
export const integrationServerTypeEnum = z.enum([
  "node",
  "bun",
  "python",
  "uv",
  "binary",
  "docker",
  "http",
  // Serverless: no MCP server spawned/connected — the integration exposes the
  // single generic credential-injecting `api_call` tool, bounded by its auth's
  // `authorizedUris`. Unifies the former `apiCall` block into the `server.type`
  // discriminator so there is one declaration model for what an integration
  // does (spawn a runner | connect a remote MCP | expose api_call).
  "api_call",
  // Author-time sugars — converted by `afps bundle` (Phase 1.05).
  "npx",
  "uvx",
]);

export type IntegrationServerType = z.infer<typeof integrationServerTypeEnum>;

/**
 * CA-trust env var enum for `server.type: "binary"` (D32 §4.1.1).
 * `NONE` flags a binary with no env-based CA trust mechanism — the
 * installer refuses unless the user opts into "egress unobservable".
 */
export const caTrustEnvEnum = z.enum([
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "NONE",
]);

export type CaTrustEnv = z.infer<typeof caTrustEnvEnum>;

const httpClientSchema = z.object({
  proxyEnv: z.string().min(1).optional(),
  caTrustEnv: caTrustEnvEnum,
});

const ociPackageRefSchema = z.object({
  registryType: z.literal("oci"),
  identifier: z.string().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, {
    error: "server.package.digest must be a sha256 digest (sha256:<64 hex>)",
  }),
  registryBaseUrl: z.string().optional(),
});

/**
 * Author-sugar package ref for `server.type: "npx"`. The bundler
 * (`afps bundle`, Phase 1.05) resolves `version` against the npm
 * registry, vendors the package + its deps into `./server/`, captures
 * the sha512 `dist.integrity` in `_meta.sourceResolution`, and
 * rewrites `server` to `{ type: "node", entryPoint: "./server/<bin>" }`.
 */
const npmPackageRefSchema = z.object({
  registryType: z.literal("npm"),
  identifier: z.string().min(1),
  version: z.string().min(1),
  registryBaseUrl: z.string().optional(),
});

/**
 * Author-sugar package ref for `server.type: "uvx"`. Same lifecycle
 * as the npm variant, against the pypi registry; rewritten to
 * `{ type: "uv", entryPoint: "./server/bin/<script>" }`.
 */
const pypiPackageRefSchema = z.object({
  registryType: z.literal("pypi"),
  identifier: z.string().min(1),
  version: z.string().min(1),
  registryBaseUrl: z.string().optional(),
});

const packageRefSchema = z.discriminatedUnion("registryType", [
  ociPackageRefSchema,
  npmPackageRefSchema,
  pypiPackageRefSchema,
]);

const mcpConfigSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const serverVariableSchema = z.object({
  isRequired: z.boolean().optional(),
  description: z.string().optional(),
  default: z.string().optional(),
});

const serverSchema = z
  .object({
    type: integrationServerTypeEnum,
    httpClient: httpClientSchema.optional(),
    entryPoint: z.string().min(1).optional(),
    package: packageRefSchema.optional(),
    url: z.string().optional(),
    variables: z.record(z.string(), serverVariableSchema).optional(),
    mcpConfig: mcpConfigSchema.optional(),
    toolsDynamic: z.boolean().optional(),

    // `api_call`-only sugars (the former top-level `apiCall` block). Which
    // declared auth supplies credentials + `authorizedUris` for the generic
    // call (optional when the integration declares exactly one auth), and the
    // resumable-upload protocols the generic tool advertises. Forbidden on any
    // other server.type (enforced in the superRefine below).
    authKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, { error: "server.authKey must match an auths.{key}" })
      .optional(),
    uploadProtocols: z.array(integrationUploadProtocolEnum).optional(),
  })
  .superRefine((server, ctx) => {
    // Exactly one of {entryPoint, package, url} per type
    const hasEntry = server.entryPoint !== undefined;
    const hasPackage = server.package !== undefined;
    const hasUrl = server.url !== undefined;

    switch (server.type) {
      case "node":
      case "bun":
      case "python":
      case "uv":
      case "binary": {
        if (!hasEntry) {
          ctx.addIssue({
            code: "custom",
            message: `server.entryPoint is required when server.type is "${server.type}"`,
            path: ["entryPoint"],
          });
        }
        if (hasPackage || hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: `server.package/url forbidden when server.type is "${server.type}"`,
            path: hasPackage ? ["package"] : ["url"],
          });
        }
        break;
      }
      // Author sugars: accept `entryPoint` (bundler input that already
      // points at a file) OR `package(npm|pypi)` (bundler resolves +
      // vendors). Exactly one is required.
      case "npx": {
        if (hasEntry === hasPackage) {
          ctx.addIssue({
            code: "custom",
            message: 'server.type "npx" requires exactly one of { entryPoint, package(npm) }',
            path: hasPackage ? ["package"] : ["entryPoint"],
          });
        }
        if (hasPackage && server.package?.registryType !== "npm") {
          ctx.addIssue({
            code: "custom",
            message: 'server.package.registryType must be "npm" when server.type is "npx"',
            path: ["package", "registryType"],
          });
        }
        if (hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: 'server.url forbidden when server.type is "npx"',
            path: ["url"],
          });
        }
        break;
      }
      case "uvx": {
        if (hasEntry === hasPackage) {
          ctx.addIssue({
            code: "custom",
            message: 'server.type "uvx" requires exactly one of { entryPoint, package(pypi) }',
            path: hasPackage ? ["package"] : ["entryPoint"],
          });
        }
        if (hasPackage && server.package?.registryType !== "pypi") {
          ctx.addIssue({
            code: "custom",
            message: 'server.package.registryType must be "pypi" when server.type is "uvx"',
            path: ["package", "registryType"],
          });
        }
        if (hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: 'server.url forbidden when server.type is "uvx"',
            path: ["url"],
          });
        }
        break;
      }
      case "docker": {
        if (!hasPackage) {
          ctx.addIssue({
            code: "custom",
            message: 'server.package is required when server.type is "docker"',
            path: ["package"],
          });
        }
        if (hasPackage && server.package?.registryType !== "oci") {
          ctx.addIssue({
            code: "custom",
            message: 'server.package.registryType must be "oci" when server.type is "docker"',
            path: ["package", "registryType"],
          });
        }
        if (hasEntry || hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: 'server.entryPoint/url forbidden when server.type is "docker"',
            path: hasEntry ? ["entryPoint"] : ["url"],
          });
        }
        break;
      }
      case "http": {
        if (!hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: 'server.url is required when server.type is "http"',
            path: ["url"],
          });
        }
        if (hasEntry || hasPackage) {
          ctx.addIssue({
            code: "custom",
            message: 'server.entryPoint/package forbidden when server.type is "http"',
            path: hasEntry ? ["entryPoint"] : ["package"],
          });
        }
        break;
      }
      case "api_call": {
        // Serverless: no runner to point at. The credential-injecting tool is
        // bounded by its auth's `authorizedUris` (cross-validated against
        // `auths.{key}` in the root superRefine, which has the auth map).
        if (hasEntry || hasPackage || hasUrl) {
          ctx.addIssue({
            code: "custom",
            message: 'server.entryPoint/package/url forbidden when server.type is "api_call"',
            path: hasEntry ? ["entryPoint"] : hasPackage ? ["package"] : ["url"],
          });
        }
        break;
      }
    }

    // `authKey` / `uploadProtocols` are api_call-only sugars.
    if (server.type !== "api_call" && (server.authKey !== undefined || server.uploadProtocols)) {
      ctx.addIssue({
        code: "custom",
        message: 'server.authKey/uploadProtocols are only valid when server.type is "api_call"',
        path: server.authKey !== undefined ? ["authKey"] : ["uploadProtocols"],
      });
    }

    // D32: caTrustEnv is required for binaries.
    if (server.type === "binary" && !server.httpClient) {
      ctx.addIssue({
        code: "custom",
        message:
          'server.httpClient.caTrustEnv is required when server.type is "binary" (D32). ' +
          'Set caTrustEnv: "NONE" to declare egress is not observable (requires user opt-in at install).',
        path: ["httpClient"],
      });
    }
  });

// ─────────────────────────────────────────────
// Transport (stdio | streamable-http | sse)
// ─────────────────────────────────────────────

const transportSchema = z.object({
  type: z.enum(["stdio", "streamable-http", "sse"]),
});

// ─────────────────────────────────────────────
// Server auth (Runtime → MCP server HTTP, distinct from upstream `auths`)
// ─────────────────────────────────────────────

const discoveryExplicitSchema = z.object({
  protectedResourceMetadataUrl: z.string().min(1),
});

const serverAuthSchema = z.object({
  type: z.literal("oauth2-mcp"),
  resource: z.string().min(1),
  discovery: z.union([z.literal("auto"), discoveryExplicitSchema]),
});

// ─────────────────────────────────────────────
// Auths — upstream API credentials (multi)
// ─────────────────────────────────────────────

const deliveryHttpSchema = z.object({
  headerName: z.string().min(1).optional(),
  headerPrefix: z.string().optional(),
  valueFrom: z
    .union([
      z.string().min(1),
      z.object({
        template: z.string().min(1),
        encoding: z.enum(["base64"]).optional(),
      }),
    ])
    .optional(),
  allowServerOverride: z.boolean().optional(),
});

const deliveryEnvEntrySchema = z.object({
  from: z.string().min(1),
  sensitive: z.boolean().optional(),
});

const deliveryFilesEntrySchema = z.object({
  from: z.string().min(1),
  mode: z
    .string()
    .regex(/^0[0-7]{3}$/, { error: "files mode must be a 4-digit octal like 0400" })
    .optional(),
});

const deliverySchema = z
  .object({
    http: deliveryHttpSchema.optional(),
    env: z.record(z.string(), deliveryEnvEntrySchema).optional(),
    files: z.record(z.string(), deliveryFilesEntrySchema).optional(),
  })
  .refine((d) => d.http !== undefined || d.env !== undefined || d.files !== undefined, {
    message: "delivery must declare at least one of: http, env, files",
  });

const authTypeEnum = z.enum(["oauth2", "oauth1", "api_key", "basic", "custom"]);

const credentialsSchemaObject = z.object({
  schema: z.looseObject({}),
});

const authSchema = z
  .object({
    type: authTypeEnum,
    required: z.boolean().optional(),

    // Endpoints — Mode A (explicit)
    authorizationUrl: z.string().optional(),
    tokenUrl: z.string().optional(),
    refreshUrl: z.string().optional(),
    revokeUrl: z.string().optional(),
    // Optional Bearer-protected endpoint returning a JSON object with
    // identity claims about the freshly-authorised account. Called by the
    // OAuth callback after a successful token exchange and merged into the
    // identity source so `extractTokenIdentity` can pull stable per-account
    // values (login, sub, email, …). Required for non-OIDC IdPs (GitHub,
    // Slack, Notion, …) where the token response itself carries no identity
    // — without it `accountId` falls back to the literal "default" and
    // every connection collapses onto the same row.
    userinfoUrl: z.string().optional(),

    // Endpoints — Mode B (RFC 9728 discovery)
    discovery: discoveryExplicitSchema.optional(),

    audience: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    scopeSeparator: z.string().optional(),
    pkceEnabled: z.boolean().optional(),
    tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic", "none"]).optional(),

    extractTokenIdentity: z.record(z.string(), z.string()).optional(),
    requiredIdentityClaims: z.array(z.string()).optional(),

    authorizedUris: z.array(z.string()),

    // When true, the auth skips the `authorizedUris` allowlist for the
    // generic `apiCall` tool — the agent may target any host (the SSRF
    // blocklist for loopback / RFC1918 / metadata still applies). Mirrors
    // the legacy `provider.definition.allowAllUris`; used by providers
    // whose base URL is supplied by the user at connect time (self-hosted
    // WooCommerce / WordPress, custom webhooks). The auth superRefine
    // requires `authorizedUris` ≥ 1 unless this is set.
    allowAllUris: z.boolean().optional(),

    // Catalog of OAuth scopes the upstream IdP exposes for this auth.
    // Mirrors `provider.definition.availableScopes`. Optional — when
    // declared, agent-declared scopes and tool requiredScopes that
    // target this auth must be a subset (validated at install time,
    // not in this schema). The IdP remains the ultimate authority on
    // what scopes are accepted at consent time.
    //
    // `implies` declares the scope hierarchy of the upstream IdP — e.g.
    // GitHub's `repo` implies `public_repo`, `admin:org` implies
    // `read:org`. Used by {@link expandGrantedScopes} to take the
    // transitive closure of a grant before computing "missing" scopes,
    // so a connection that was granted `repo` doesn't appear to be
    // missing `public_repo`. Entries listed in `implies` must be values
    // declared elsewhere in the same catalog (validated at install).
    availableScopes: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string().min(1),
          description: z.string().optional(),
          implies: z.array(z.string().min(1)).optional(),
        }),
      )
      .optional(),

    credentials: credentialsSchemaObject.optional(),

    delivery: deliverySchema,
  })
  .superRefine((auth, ctx) => {
    // `authorizedUris` must declare at least one pattern unless the auth
    // opts into `allowAllUris` (SSRF blocklist still applies at runtime).
    if (auth.authorizedUris.length === 0 && !auth.allowAllUris) {
      ctx.addIssue({
        code: "custom",
        message:
          "auths.{key}.authorizedUris must declare at least one URI pattern (or set allowAllUris)",
        path: ["authorizedUris"],
      });
    }
    if (auth.type === "oauth2") {
      const hasExplicit = auth.authorizationUrl && auth.tokenUrl;
      const hasDiscovery = auth.discovery !== undefined;
      if (!hasExplicit && !hasDiscovery) {
        ctx.addIssue({
          code: "custom",
          message:
            "oauth2 auth requires either (authorizationUrl + tokenUrl) or discovery.protectedResourceMetadataUrl",
          path: ["authorizationUrl"],
        });
      }
    }
    if (
      (auth.type === "api_key" || auth.type === "basic" || auth.type === "custom") &&
      !auth.credentials
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${auth.type} auth requires credentials.schema declaring the field shape`,
        path: ["credentials"],
      });
    }
    // If both `scopes` (defaults) and `availableScopes` (catalog) are
    // declared, defaults must be a subset of the catalog — protects
    // against typos in the manifest and aligns default OAuth behaviour
    // with what's documented as installable.
    if (auth.availableScopes && auth.scopes) {
      const catalog = new Set(auth.availableScopes.map((s) => s.value));
      for (const s of auth.scopes) {
        if (!catalog.has(s)) {
          ctx.addIssue({
            code: "custom",
            message: `default scope "${s}" is not declared in availableScopes catalog`,
            path: ["scopes"],
          });
        }
      }
    }
    // `implies` entries must reference other catalog values. Cycles in
    // the graph (X→Y→X) aren't detected here — they don't break the
    // expansion (it terminates on already-visited nodes), they're just
    // semantically nonsensical; not worth the DFS at install time.
    if (auth.availableScopes) {
      const catalog = new Set(auth.availableScopes.map((s) => s.value));
      for (const s of auth.availableScopes) {
        for (const target of s.implies ?? []) {
          if (target === s.value) {
            ctx.addIssue({
              code: "custom",
              message: `availableScopes entry "${s.value}" cannot imply itself`,
              path: ["availableScopes"],
            });
          } else if (!catalog.has(target)) {
            ctx.addIssue({
              code: "custom",
              message: `availableScopes entry "${s.value}" implies "${target}" which is not in the catalog`,
              path: ["availableScopes"],
            });
          }
        }
      }
    }
  });

// ─────────────────────────────────────────────
// Tools — per-tool scope + URL pattern metadata
// ─────────────────────────────────────────────

/**
 * HTTP method enum used in `tools.{name}.urlPatterns[].methods`. Closed
 * list matching the methods the MITM proxy enforces against.
 */
const httpMethodEnum = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * URL pattern an integration tool will reach. Consumed at runtime
 * (sidecar MITM) to enforce that only requests covered by the tool's
 * `requiredScopes` actually go upstream — a defence-in-depth on top of
 * the IdP-side scope narrowing. Pattern grammar matches the existing
 * `authorizedUris` semantics (glob-style with `**`).
 */
const toolUrlPatternSchema = z.object({
  pattern: z.string().min(1),
  methods: z.array(httpMethodEnum).optional(),
});

/**
 * Per-tool metadata mapping each MCP tool the integration exposes to
 * the OAuth scopes it needs and the URL surface it touches. Optional
 * everywhere — integrations that omit a tool entry default to "tool
 * requires the full set of auth.scopes defaults" (= today's behaviour).
 *
 * `requiredAuthKey` disambiguates which auth in `auths.{key}` the
 * scopes are relative to, for multi-auth integrations. When omitted,
 * the resolver picks the single declared auth (or fails-loudly at
 * install time if there's ambiguity).
 */
const toolMetadataSchema = z.object({
  requiredScopes: z.array(z.string()).optional(),
  requiredAuthKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, {
      error: "tools.{name}.requiredAuthKey must match an auths.{key}",
    })
    .optional(),
  urlPatterns: z.array(toolUrlPatternSchema).optional(),
});

const toolsRecordSchema = z.record(
  z.string().regex(/^[a-z_][a-z0-9_]*$/, {
    error: "tool names must match /^[a-z_][a-z0-9_]*$/",
  }),
  toolMetadataSchema,
);

export type IntegrationToolMetadata = z.infer<typeof toolMetadataSchema>;

// ─────────────────────────────────────────────
// Integration manifest (root)
// ─────────────────────────────────────────────

export const integrationManifestSchema = z
  .object({
    $schema: z.string().optional(),
    manifestVersion: z.string().regex(manifestVersionRegex, {
      error: "manifestVersion must match 1.X",
    }),
    type: z.literal("integration"),
    name: z.string().regex(scopedNameRegex, {
      error: "name must follow @scope/package-name",
    }),
    version: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    license: z.string().optional(),
    author: z
      .union([
        z.string().min(1),
        z.object({
          name: z.string().min(1),
          email: z.string().optional(),
          url: z.string().optional(),
        }),
      ])
      .optional(),
    repository: z
      .union([
        z.string().min(1),
        z.object({
          type: z.string().min(1),
          url: z.string().min(1),
        }),
      ])
      .optional(),
    privacyPolicy: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    icon: z.string().optional(),
    compatibility: z
      .object({
        afps: z.string().optional(),
        mcp: z.string().optional(),
      })
      .optional(),
    _meta: z.looseObject({}).optional(),

    // Every integration declares a `server` — its `type` is the single
    // discriminator for what the integration does: spawn a runner
    // (node|python|binary|…), connect a remote MCP (http), or expose the
    // generic credential-injecting tool (api_call). Optional only so the root
    // superRefine can emit a friendly "must declare a server" error.
    server: serverSchema.optional(),
    transport: transportSchema.optional(),
    serverAuth: serverAuthSchema.optional(),
    auths: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]*$/, {
          error: "auth keys must match /^[a-z][a-z0-9_]*$/",
        }),
        authSchema,
      )
      .optional(),

    // Per-tool scope + URL pattern metadata (niveau 2 scope model).
    // Optional and additive — integrations that don't declare `tools`
    // keep the legacy behaviour (token scoped to auth.scopes defaults,
    // no per-tool URL enforcement, no scope inference from agent tool
    // selection).
    tools: toolsRecordSchema.optional(),
  })
  .superRefine((m, ctx) => {
    // An integration must declare a `server` — its `type` says what it does.
    if (!m.server) {
      ctx.addIssue({
        code: "custom",
        message: "an integration must declare a server",
        path: ["server"],
      });
    }

    // `api_call` injects a credential, so it needs an auth to draw from.
    if (m.server?.type === "api_call") {
      const authKeys = m.auths ? Object.keys(m.auths) : [];
      if (authKeys.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: 'server.type "api_call" requires at least one declared auth in auths.{key}',
          path: ["server"],
        });
      } else if (m.server.authKey) {
        if (!authKeys.includes(m.server.authKey)) {
          ctx.addIssue({
            code: "custom",
            message: `server.authKey "${m.server.authKey}" does not match any auths.{key}`,
            path: ["server", "authKey"],
          });
        }
      } else if (authKeys.length > 1) {
        ctx.addIssue({
          code: "custom",
          message: "server.authKey is required when the integration declares multiple auths",
          path: ["server", "authKey"],
        });
      }
    }

    // `serverAuth` / `transport` describe how to reach an MCP server —
    // meaningless without one.
    if (m.serverAuth && !m.server) {
      ctx.addIssue({
        code: "custom",
        message: "serverAuth is only valid when a server is declared",
        path: ["serverAuth"],
      });
    }

    // `serverAuth` only makes sense for remote transports.
    if (m.serverAuth) {
      const transportType = m.transport?.type ?? "stdio";
      if (transportType === "stdio") {
        ctx.addIssue({
          code: "custom",
          message:
            'serverAuth is only valid when transport.type is "streamable-http" or "sse" (stdio servers do not have an HTTP transport to authenticate against)',
          path: ["serverAuth"],
        });
      }
    }

    // Cross-validate `tools.{name}.requiredAuthKey` against `auths.{key}`
    // and `tools.{name}.requiredScopes` against the targeted auth's
    // `availableScopes` catalog. Both checks are skipped when the
    // corresponding declaration is absent — catalogs and auth keys are
    // opt-in.
    if (!m.tools) return;
    const authKeys = m.auths ? Object.keys(m.auths) : [];
    for (const [toolName, tool] of Object.entries(m.tools)) {
      // Pick the auth this tool's scopes apply to: explicit key, or
      // the single declared auth, or — if ambiguous — refuse to guess.
      let targetAuthKey: string | undefined;
      if (tool.requiredAuthKey) {
        if (!authKeys.includes(tool.requiredAuthKey)) {
          ctx.addIssue({
            code: "custom",
            message: `tools.${toolName}.requiredAuthKey "${tool.requiredAuthKey}" does not match any auths.{key}`,
            path: ["tools", toolName, "requiredAuthKey"],
          });
          continue;
        }
        targetAuthKey = tool.requiredAuthKey;
      } else if (authKeys.length === 1) {
        targetAuthKey = authKeys[0];
      } else if (authKeys.length > 1 && tool.requiredScopes && tool.requiredScopes.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `tools.${toolName}.requiredScopes declared but the integration has multiple auths; add requiredAuthKey to disambiguate`,
          path: ["tools", toolName, "requiredAuthKey"],
        });
        continue;
      }

      // Validate requiredScopes ⊆ availableScopes (when both declared).
      if (targetAuthKey && tool.requiredScopes && tool.requiredScopes.length > 0) {
        const auth = m.auths?.[targetAuthKey];
        if (auth?.availableScopes) {
          const catalog = new Set(auth.availableScopes.map((s) => s.value));
          for (const s of tool.requiredScopes) {
            if (!catalog.has(s)) {
              ctx.addIssue({
                code: "custom",
                message: `tools.${toolName}.requiredScopes contains "${s}" not declared in auths.${targetAuthKey}.availableScopes`,
                path: ["tools", toolName, "requiredScopes"],
              });
            }
          }
        }
      }
    }
  });

export type IntegrationManifest = z.infer<typeof integrationManifestSchema>;

// ─────────────────────────────────────────────
// Niveau 2 — install-time validation helpers
// ─────────────────────────────────────────────

/**
 * Names of MCP tools the integration declares in its top-level `tools`
 * record. Empty when the integration didn't opt into per-tool metadata.
 */
export function getDeclaredToolNames(manifest: IntegrationManifest): string[] {
  return manifest.tools ? Object.keys(manifest.tools) : [];
}

/**
 * Tool name the generic `apiCall` capability is exposed under (before the
 * `{namespace}__` prefix the sidecar's McpHost applies). Constant so the
 * spawn resolver, the McpHost allowlist, and the agent editor agree.
 */
export const API_CALL_TOOL_NAME = "api_call";

/**
 * Resolve the effective `api_call` configuration for an integration, or
 * `null` when `server.type !== "api_call"`. Returns the resolved `authKey`
 * (explicit `server.authKey`, or the lone declared auth) and the declared
 * `server.uploadProtocols`. The manifest schema guarantees that for an
 * `api_call` server there is at least one auth and `authKey` is unambiguous,
 * so the resolution here cannot fail for a validated manifest.
 */
export function getApiCallConfig(
  manifest: IntegrationManifest,
): { authKey: string; uploadProtocols: IntegrationUploadProtocol[] } | null {
  if (manifest.server?.type !== "api_call") return null;
  const authKeys = manifest.auths ? Object.keys(manifest.auths) : [];
  const authKey = manifest.server.authKey ?? authKeys[0];
  if (!authKey) return null;
  return {
    authKey,
    uploadProtocols: manifest.server.uploadProtocols ?? [],
  };
}

/**
 * Required OAuth scopes for a single tool, looked up against the
 * integration manifest's `tools.{name}.requiredScopes`. Returns an
 * empty array when the tool isn't declared, which the resolver
 * (Phase 2+) treats as "no scope contribution from this tool".
 */
export function getToolRequiredScopes(
  manifest: IntegrationManifest,
  toolName: string,
): readonly string[] {
  return manifest.tools?.[toolName]?.requiredScopes ?? [];
}

/**
 * URL patterns a single tool will reach upstream, looked up against
 * `tools.{name}.urlPatterns`. Returns `undefined` when the tool isn't
 * declared or didn't declare patterns — Phase 4 treats that as "cannot
 * safely narrow the MITM envelope for this tool". The distinction
 * between "no entry" and "empty array" matters: an explicit empty
 * array would mean "tool talks to nothing", which Phase 4 honours.
 */
export function getToolUrlPatterns(
  manifest: IntegrationManifest,
  toolName: string,
): ReadonlyArray<{ pattern: string; methods?: readonly string[] }> | undefined {
  return manifest.tools?.[toolName]?.urlPatterns;
}

/**
 * Which auth keys an agent actually needs connected, given its declared
 * `tools[]` selection on the integration. Returns `[]` when the agent
 * picked zero tools (or didn't declare any selection at all) — the
 * integration is then declared-but-inert and no connection is required
 * at run-kickoff. For a non-empty selection, returns the union of each
 * tool's `requiredAuthKey` (single-auth integrations route every tool
 * to the lone key).
 *
 * Pure function. Single source of truth for the frontend status badge
 * (`agent-integrations-block.tsx`) and the backend gate
 * (`collectIntegrationDependencyErrors`), so the two cannot drift.
 */
export function requiredAuthKeysForAgent(
  manifest: IntegrationManifest,
  agentTools: readonly string[] | undefined,
  agentScopes?: readonly string[] | undefined,
): string[] {
  const hasTools = !!agentTools && agentTools.length > 0;
  const hasScopes = !!agentScopes && agentScopes.length > 0;
  // "Active" = the agent declared a usage. MCP integrations express it via
  // selected tools; apiCall integrations (former providers) expose no tools,
  // so selected oauth scopes are the only signal. Neither → inert, no auth.
  if (!hasTools && !hasScopes) return [];
  const declaredAuths = manifest.auths ? Object.keys(manifest.auths) : [];
  if (declaredAuths.length === 0) return [];
  if (declaredAuths.length === 1) return declaredAuths;

  const toolsRecord = manifest.tools ?? {};
  const out = new Set<string>();
  for (const toolName of agentTools ?? []) {
    const tool = toolsRecord[toolName];
    if (!tool || !tool.requiredAuthKey) continue;
    if (declaredAuths.includes(tool.requiredAuthKey)) out.add(tool.requiredAuthKey);
  }
  // Scope-only selection (apiCall integrations) maps each selected scope to
  // the auth(s) whose `availableScopes` catalog declares it.
  if (hasScopes) {
    for (const authKey of declaredAuths) {
      const catalog = manifest.auths?.[authKey]?.availableScopes ?? [];
      const values = new Set(catalog.map((s) => s.value));
      if (agentScopes!.some((s) => values.has(s))) out.add(authKey);
    }
  }
  // Fallback: if neither tools nor scopes pinned an auth, require every
  // declared auth — the agent must pick a side at consent rather than
  // silently get a free pass.
  return out.size === 0 ? declaredAuths : [...out];
}

/**
 * Required oauth scopes for an agent's use of (integration, authKey): the
 * union of tool-inferred scopes ({@link scopesContributedByTools}) and the
 * agent's explicitly-selected scopes. apiCall integrations expose no tools,
 * so the explicit selection is the only scope signal there. Mirrors the
 * union `integration-scope-resolver` already applies for the org breakdown.
 */
export function requiredScopesForAgent(input: {
  manifest: IntegrationManifest;
  authKey: string;
  agentTools: readonly string[] | undefined;
  agentScopes: readonly string[] | undefined;
}): string[] {
  const viaTools = scopesContributedByTools(input);
  const viaExplicit = input.agentScopes ? [...input.agentScopes] : [];
  return [...new Set([...viaTools, ...viaExplicit])];
}

/**
 * Union of `requiredScopes` across the agent's selected tools, filtered
 * by `requiredAuthKey` so multi-auth integrations stay scoped to the
 * current auth. Returns `[]` when the agent picked zero tools — least
 * privilege by default, the OAuth kickoff only requests `auth.scopes`
 * defaults in that case.
 *
 * Pure function. Single source of truth for the frontend status badge
 * and the backend gate.
 */
export function scopesContributedByTools(input: {
  manifest: IntegrationManifest;
  authKey: string;
  agentTools: readonly string[] | undefined;
}): string[] {
  if (!input.agentTools || input.agentTools.length === 0) return [];
  const toolsRecord = input.manifest.tools;
  if (!toolsRecord) return [];

  const authKeys = input.manifest.auths ? Object.keys(input.manifest.auths) : [];
  const isSingleAuth = authKeys.length === 1;

  const out = new Set<string>();
  for (const toolName of input.agentTools) {
    const tool = toolsRecord[toolName];
    if (!tool || !tool.requiredScopes || tool.requiredScopes.length === 0) continue;
    if (isSingleAuth) {
      if (authKeys[0] !== input.authKey) continue;
    } else if (tool.requiredAuthKey !== input.authKey) continue;
    for (const s of tool.requiredScopes) out.add(s);
  }
  return [...out];
}

/**
 * Expand granted OAuth scopes through the manifest's `implies` hierarchy
 * (e.g. GitHub `repo` ⇒ `public_repo`, `security_events`, …) so a parent
 * grant doesn't appear to be missing its narrower children when computing
 * insufficient-scopes diffs.
 */
export function expandGrantedScopes(
  granted: readonly string[],
  manifest: IntegrationManifest,
  authKey: string,
): string[] {
  const catalog = manifest.auths?.[authKey]?.availableScopes ?? [];
  const impliesBy = new Map<string, readonly string[]>();
  for (const entry of catalog) {
    if (entry.implies?.length) impliesBy.set(entry.value, entry.implies);
  }
  const out = new Set(granted);
  if (impliesBy.size === 0) return [...out];

  const stack = [...granted];
  while (stack.length > 0) {
    for (const child of impliesBy.get(stack.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return [...out];
}

/**
 * Union of every OAuth scope advertised across the integration's auths.
 * Used by {@link validateAgentIntegrationScopes} to refuse agent-declared
 * scopes that no auth on this integration even claims to support. When
 * no auth declares an `availableScopes` catalog, returns an empty list
 * and the caller skips the check (legacy behaviour).
 */
export function getAvailableScopes(manifest: IntegrationManifest): readonly string[] {
  if (!manifest.auths) return [];
  const out = new Set<string>();
  for (const auth of Object.values(manifest.auths)) {
    if (auth.availableScopes) {
      for (const s of auth.availableScopes) out.add(s.value);
    }
  }
  return [...out];
}

/** Structured validation error returned by {@link validateAgentIntegrationScopes}. */
export interface AgentIntegrationScopeError {
  /** Dotted JSON path into the agent manifest (`dependencies.integrations.<id>.<field>`). */
  field: string;
  /** Stable machine-readable code consumed by route layer / UI. */
  code: "unknown_tool" | "scope_not_in_catalog";
  /** Human-readable detail for surfaces that don't translate `code`. */
  message: string;
}

/**
 * Validate an agent's tool/scope selection against the integration
 * manifest's catalog. Returns an array of structured errors — empty
 * means the selection is install-valid.
 *
 * Backward compat semantics (Phase 0/1 strict):
 *  - When the integration declares no `tools` block, any agent tool
 *    selection is accepted (= legacy "all tools allowed" default).
 *  - When the integration declares no `availableScopes` catalog on any
 *    auth, any agent scope is accepted (the IdP is the ultimate
 *    authority at consent time).
 *
 * The function is pure and DB-free; the service-layer wrapper resolves
 * the integration manifest from the DB before calling it.
 */
export function validateAgentIntegrationScopes(
  selection: Pick<ManifestIntegrationEntry, "id" | "tools" | "scopes">,
  integrationManifest: IntegrationManifest,
): AgentIntegrationScopeError[] {
  const errors: AgentIntegrationScopeError[] = [];

  // Tool allowlist must be a subset of declared tools (when declared).
  if (selection.tools && selection.tools.length > 0) {
    const declared = new Set(getDeclaredToolNames(integrationManifest));
    if (declared.size > 0) {
      for (const tool of selection.tools) {
        if (!declared.has(tool)) {
          errors.push({
            field: `integrations.${selection.id}.tools`,
            code: "unknown_tool",
            message: `Tool "${tool}" is not declared by integration ${selection.id}`,
          });
        }
      }
    }
    // declared.size === 0 → integration opts out of catalog enforcement.
  }

  // Manual scopes must be a subset of the union of availableScopes
  // (when at least one auth declares a catalog).
  if (selection.scopes && selection.scopes.length > 0) {
    const catalog = getAvailableScopes(integrationManifest);
    if (catalog.length > 0) {
      const catalogSet = new Set(catalog);
      for (const scope of selection.scopes) {
        if (!catalogSet.has(scope)) {
          errors.push({
            field: `integrations.${selection.id}.scopes`,
            code: "scope_not_in_catalog",
            message: `Scope "${scope}" is not declared in availableScopes catalog of integration ${selection.id}`,
          });
        }
      }
    }
  }

  return errors;
}

// ────────────────────────────────────────────────────────────────────
// Flat connection model — types consumed by the integration connection
// resolver (apps/api/src/services/integration-connection-resolver.ts).
//
// The resolver is the single source of truth for "which integration
// connection does this run use?" — pin > run override > schedule
// override > fallback (own + shared, 1 = auto, 0 = not_connected,
// N = must_choose). These types live in core so the runtime + the API
// + the runtime-pi sidecar can all speak the same vocabulary without
// reaching into apps/api.
// ────────────────────────────────────────────────────────────────────

/**
 * Per-integration connection picks. Used on `runs.connection_overrides`
 * (caller's run-time choice) and `package_schedules.connection_overrides`
 * (frozen at schedule create).
 *
 * Shape: `{ "@scope/integration": "<connection_id>" }`. The chosen
 * connection carries its own authKey — at runtime selection we don't
 * discriminate between OAuth / api_key / basic / custom. The agent
 * author's `tools.{name}.requiredAuthKey` informs OAuth-scope inference
 * at consent time but never gates run-time credential choice.
 */
export type ConnectionOverrides = Record<string, string>;

/** Where a resolved connection came from — drives the audit + UI badge. */
export type ConnectionResolutionSource =
  | "admin_pin"
  | "org_default_enforced"
  | "run_override"
  | "schedule_override"
  | "member_pin"
  | "org_default"
  | "fallback_auto";

/** Per-integration resolution result. */
export interface ResolvedConnection {
  connectionId: string;
  source: ConnectionResolutionSource;
}

/**
 * Snapshot of the resolver output for one run. Persisted on
 * `runs.resolved_connections` so post-hoc audits don't depend on
 * still-mutable pin / connection state.
 *
 * Shape: `{ "@scope/integration": ResolvedConnection }`.
 */
export type ResolvedConnectionMap = Record<string, ResolvedConnection>;

/** Error codes the resolver emits per integration. */
export type ConnectionResolutionErrorCode =
  | "not_connected"
  | "needs_reconnection"
  | "connection_blocked_by_admin"
  | "pinned_connection_unavailable"
  | "override_connection_unavailable"
  | "must_choose_connection"
  | "insufficient_scopes";

/**
 * One unresolved integration plus structured detail.
 *
 * - `not_connected` — actor has no own connection and no shared one matches.
 * - `needs_reconnection` — the chosen connection has the flag set.
 * - `connection_blocked_by_admin` — actor isn't admin and the (app, integration)
 *    has `block_user_connections=true`. Reported only at the
 *    CREATE-connection endpoint; the resolver never sees this case in
 *    practice (it surfaces missing connections, not creation refusals).
 * - `pinned_connection_unavailable` — pin points at a connection the actor
 *    can't see (deleted, unshared, app moved). Pin should usually be cleaned
 *    up by admin or auto-purged via FK CASCADE; transient case.
 * - `override_connection_unavailable` — run/schedule override points at an
 *    invisible connection. Caller error.
 * - `must_choose_connection` — fallback found >1 candidate; the UI must
 *    prompt for a pick before retrying.
 * - `insufficient_scopes` — the RESOLVED connection's granted OAuth scopes
 *    don't cover what the agent's selected tools require on that connection's
 *    auth. Run is blocked. If the actor owns the connection the UI offers an
 *    incremental-consent upgrade; otherwise it surfaces a read-only error
 *    (the connection belongs to someone else — only its owner can re-consent).
 */
export interface ConnectionResolutionError {
  integrationId: string;
  code: ConnectionResolutionErrorCode;
  /** Candidate connection ids when `code === "must_choose_connection"`. */
  candidateConnectionIds?: string[];
  /** The under-scoped connection when `code === "insufficient_scopes"`. */
  connectionId?: string;
  /** Scopes the agent needs that the connection lacks (insufficient_scopes). */
  missingScopes?: string[];
  /**
   * True when the resolved connection belongs to the current actor — drives
   * the upgrade-vs-error branch in the UI for `insufficient_scopes`.
   */
  ownedByActor?: boolean;
  message: string;
}

/** Full resolver output. */
export interface ConnectionResolutionResult {
  resolved: ResolvedConnectionMap;
  errors: ConnectionResolutionError[];
}
