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
  // Author-time sugars — converted by `afps bundle` (Phase 1.05).
  "npx",
  "uvx",
]);

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
    entryPoint: z.string().min(1).optional(),
    package: packageRefSchema.optional(),
    url: z.string().optional(),
    variables: z.record(z.string(), serverVariableSchema).optional(),
    mcpConfig: mcpConfigSchema.optional(),
    toolsDynamic: z.boolean().optional(),
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
    }
  });

// ─────────────────────────────────────────────
// OAuth2 discovery (used by `auths.{key}.discovery`)
// ─────────────────────────────────────────────

const discoveryExplicitSchema = z.object({
  protectedResourceMetadataUrl: z.string().min(1),
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

// ─────────────────────────────────────────────
// connect — declarative Login acquisition (spec §4.8)
// ─────────────────────────────────────────────

// One value pulled out of the login response. The `output` array on the step
// decides which extracted values become the final injectable bundle.
// `regex.pattern` is length-capped here (ReDoS surface) and runs against a
// size-capped response body at execution time.
const connectExtractorSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("json"), path: z.string().min(1).max(256) }),
  z.object({ from: z.literal("jwt"), token: z.string().min(1), path: z.string().min(1).max(256) }),
  z.object({
    from: z.literal("regex"),
    pattern: z.string().min(1).max(256),
    group: z.number().int().min(0).max(20).optional(),
  }),
  z.object({ from: z.literal("header"), name: z.string().min(1) }),
  z.object({ from: z.literal("cookie"), name: z.string().min(1) }),
]);

const connectStepSchema = z.object({
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    // `{{...}}` placeholders are substituted (from credential inputs) by the
    // platform-side engine — the manifest carries only placeholders, never the
    // secret.
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    contentType: z.enum(["application/x-www-form-urlencoded", "application/json"]).optional(),
  }),
  // Declared OK statuses; defaults to 2xx when omitted.
  okStatus: z.array(z.number().int().min(100).max(599)).optional(),
  extract: z.record(z.string(), connectExtractorSchema).optional(),
  // Names (subset of `extract` keys) promoted to the final injectable bundle.
  output: z.array(z.string()).optional(),
});

const connectLimitsSchema = z.object({
  stepTimeoutMs: z.number().int().min(1).max(60_000).optional(),
  maxResponseBytes: z.number().int().min(1).max(5_000_000).optional(),
});

const connectSchema = z.object({
  // ── Declarative login (stateless) — mutually exclusive with `tool` ──
  // A single login request: substitute the credential into one HTTP call and
  // extract the injectable token/cookie from its response. Intentionally
  // single-shot and stateless — no inter-step state, no cookie jar, no
  // redirect following. Anything stateful (multi-cookie sessions, TLS
  // impersonation, refresh, redirect chains) belongs on `tool` (Orchestrated).
  // Modelled as a 1-element array for forward compatibility / shape stability.
  steps: z.array(connectStepSchema).length(1).optional(),
  limits: connectLimitsSchema.optional(),
  // Output name holding seconds-to-expiry → computes expires_at.
  expiresInOutput: z.string().optional(),
  // Output names to also record as identity claims.
  identityOutputs: z.array(z.string()).optional(),

  // ── Orchestrated (code) — mutually exclusive with `steps` (spec §4.3) ──
  // Name of the MCP tool, exposed by the integration's bundled server, that
  // drives the login dance. Runs in the sidecar; the secret never reaches it
  // (substitution is proxy-side). Selecting `tool` makes this an
  // OrchestratedStrategy auth.
  tool: z.string().min(1).optional(),
  // When the FIRST acquisition happens: `link` (durable, at dashboard click —
  // ephemeral connect-run) | `run-start` (at each agent run, in the run's
  // sidecar). `reauthOn` is the orthogonal RE-acquisition trigger.
  runAt: z.enum(["link", "run-start"]).optional(),
  // HTTP status codes that trigger a re-acquisition (re-bootstrap) mid-run —
  // typically `[401]`. The MITM signals; the sandbox re-runs the tool.
  reauthOn: z.array(z.number().int().min(100).max(599)).max(8).optional(),
  // Persist the bootstrap `inputs` (login secret) encrypted, NON-injectable,
  // so the tool can re-bootstrap an expired session without re-prompting.
  persistLoginSecret: z.boolean().optional(),
  // Injectable outputs the tool is expected to produce. Authoritative set the
  // `delivery.*` gating (spec §4.6) is validated against.
  produces: z.array(z.string().min(1)).max(32).optional(),
});

/** Extract `{{name}}` placeholder names from a delivery template. */
function extractTemplateTokens(template: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Every credential field name a `delivery.{http,env,files}` block references.
 * Used to enforce the §4.6 gating rule: a connect auth's delivery may only
 * reference declared `outputs` — never a bootstrap `inputs` (login secret).
 */
function collectDeliveryRefs(delivery: {
  http?: { valueFrom?: string | { template: string; encoding?: "base64" } };
  env?: Record<string, { from: string }>;
  files?: Record<string, { from: string }>;
}): string[] {
  const refs: string[] = [];
  const vf = delivery.http?.valueFrom;
  if (typeof vf === "string") refs.push(vf);
  else if (vf && typeof vf === "object") refs.push(...extractTemplateTokens(vf.template));
  for (const e of Object.values(delivery.env ?? {})) refs.push(e.from);
  for (const e of Object.values(delivery.files ?? {})) refs.push(e.from);
  return refs;
}

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

    // Extra static query parameters merged verbatim into the OAuth2
    // authorize URL (oauth2 only). Required by IdPs that gate
    // refresh-token issuance on an authorize-time flag — notably Google,
    // which only returns a `refresh_token` when `access_type=offline` (and
    // re-issues one on re-consent only with `prompt=consent`). Without it
    // the access token expires after ~1h with no way to refresh, forcing a
    // manual reconnect. Merged last in {@link initiateIntegrationOAuth} so
    // a manifest can override the dynamic `prompt`; it must not redeclare
    // the core PKCE/identity params (client_id, redirect_uri, state, …).
    authorizationParams: z.record(z.string(), z.string()).optional(),
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
    // `read:org`. Used by {@link expandScopesGranted} to take the
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

    // Declarative single-request login (Login). `custom`-only. The
    // platform-side engine runs the request; no untrusted code (cf. the
    // code-orchestrated connect.tool).
    connect: connectSchema.optional(),

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
    // `connect` is only meaningful for `custom` auths — oauth2 has its own
    // flow, api_key/basic are paste-the-bag. It is EITHER a declarative
    // `steps` chain (Login) OR a code-orchestrated `tool` (Orchestrated) —
    // never both (spec §4.2/§4.3).
    if (auth.connect) {
      const { connect } = auth;
      if (auth.type !== "custom") {
        ctx.addIssue({
          code: "custom",
          message: `auth.connect is only valid on type 'custom' (got '${auth.type}')`,
          path: ["connect"],
        });
      }
      const hasSteps = connect.steps !== undefined;
      const hasTool = connect.tool !== undefined;
      if (hasSteps === hasTool) {
        ctx.addIssue({
          code: "custom",
          message:
            "auth.connect must declare exactly one of `steps` (declarative login) or `tool` (Orchestrated)",
          path: ["connect"],
        });
      }

      // The set of injectable outputs this auth declares — what `delivery.*`
      // is allowed to reference (§4.6 gating). Declarative login: the step's
      // `output` names. Orchestrated: the `produces` list.
      const declaredOutputs = new Set<string>();

      if (hasSteps) {
        // Each `output` must reference a name extracted in the same login
        // request, and the final outputs set must cover expiresInOutput /
        // identityOutputs.
        connect.steps!.forEach((step, i) => {
          const extractKeys = new Set(Object.keys(step.extract ?? {}));
          for (const name of step.output ?? []) {
            if (!extractKeys.has(name)) {
              ctx.addIssue({
                code: "custom",
                message: `connect.steps[${i}].output '${name}' has no matching extractor in the same step`,
                path: ["connect", "steps", i, "output"],
              });
            }
            declaredOutputs.add(name);
          }
        });
        if (declaredOutputs.size === 0) {
          ctx.addIssue({
            code: "custom",
            message: "auth.connect must declare at least one step `output` (the injectable result)",
            path: ["connect"],
          });
        }
        if (connect.expiresInOutput && !declaredOutputs.has(connect.expiresInOutput)) {
          ctx.addIssue({
            code: "custom",
            message: `connect.expiresInOutput '${connect.expiresInOutput}' is not a declared output`,
            path: ["connect", "expiresInOutput"],
          });
        }
        for (const name of connect.identityOutputs ?? []) {
          if (!declaredOutputs.has(name)) {
            ctx.addIssue({
              code: "custom",
              message: `connect.identityOutputs '${name}' is not a declared output`,
              path: ["connect", "identityOutputs"],
            });
          }
        }
      }

      if (hasTool) {
        // Orchestrated fields that only make sense with `tool`.
        if (connect.runAt === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "connect.tool requires `runAt` ('link' | 'run-start')",
            path: ["connect", "runAt"],
          });
        }
        // Persisting the login secret means an `inputs` plane will exist, so a
        // `produces` list is REQUIRED — it's what makes the §4.6 delivery
        // gating enforceable (otherwise an input could be referenced).
        if (connect.persistLoginSecret && (connect.produces?.length ?? 0) === 0) {
          ctx.addIssue({
            code: "custom",
            message:
              "connect.persistLoginSecret requires a non-empty `produces` (so delivery.* gating can distinguish injectable outputs from the persisted login secret)",
            path: ["connect", "produces"],
          });
        }
        for (const name of connect.produces ?? []) declaredOutputs.add(name);
      } else {
        // `steps` mode: orchestrated-only fields are meaningless.
        for (const field of [
          "tool",
          "runAt",
          "reauthOn",
          "persistLoginSecret",
          "produces",
        ] as const) {
          if (connect[field] !== undefined) {
            ctx.addIssue({
              code: "custom",
              message: `connect.${field} is only valid with connect.tool (Orchestrated), not connect.steps`,
              path: ["connect", field],
            });
          }
        }
      }

      // §4.6 gating: a connect auth's delivery may only reference declared
      // `outputs`. A delivery pointing at a credentials-schema field that is
      // NOT an output (i.e. a bootstrap login secret) is a manifest error —
      // never a silent injection of the secret.
      if (declaredOutputs.size > 0) {
        for (const ref of collectDeliveryRefs(auth.delivery)) {
          if (!declaredOutputs.has(ref)) {
            ctx.addIssue({
              code: "custom",
              message: `delivery references '${ref}', which is not a declared connect output — delivery.* may only reference injectable outputs (spec §4.6)`,
              path: ["delivery"],
            });
          }
        }
      }
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

    // A `server` capability spawns a runner (node|python|binary|…) or connects
    // a remote MCP (http). Optional: an integration may instead (or also)
    // expose the generic credential-injecting tool via the `apiCall` block
    // below. The root superRefine requires at least one of { server, apiCall }.
    server: serverSchema.optional(),
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

    // Generic `api_call` capability — the single model for exposing the
    // in-process credential-injecting `api_call` tool. Two shapes:
    //   - alone (no `server`): the serverless integration — the tool IS the
    //     integration (Gmail, Stripe, … — the dominant catalog pattern).
    //   - alongside a `server` (node|…|http): the tool runs on the sidecar's
    //     McpHost, OUTSIDE the integration's container, so the server code
    //     never sees the credential.
    // Either way it is bounded by `auths.{authKey}.authorizedUris`. `authKey`
    // names which declared auth supplies the credential + URL allowlist.
    apiCall: z
      .object({
        authKey: z.string().regex(/^[a-z][a-z0-9_]*$/, {
          error: "apiCall.authKey must match an auths.{key}",
        }),
        uploadProtocols: z.array(integrationUploadProtocolEnum).optional(),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    // An integration must declare at least one capability: a `server` (spawn a
    // runner | connect a remote MCP) and/or the generic `apiCall` tool.
    if (!m.server && !m.apiCall) {
      ctx.addIssue({
        code: "custom",
        message: "an integration must declare a server and/or an apiCall capability",
        path: ["server"],
      });
    }

    // `apiCall` injects a credential, so it needs an auth to draw from. The
    // referenced auth must exist; its own schema already guarantees a URL
    // bound (`authorizedUris` non-empty OR `allowAllUris`), so no extra check.
    if (m.apiCall) {
      const authKeys = m.auths ? Object.keys(m.auths) : [];
      if (!authKeys.includes(m.apiCall.authKey)) {
        ctx.addIssue({
          code: "custom",
          message: `apiCall.authKey "${m.apiCall.authKey}" does not match any auths.{key}`,
          path: ["apiCall", "authKey"],
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
 * `null` when the integration declares no `apiCall` capability.
 *
 * Single source: the top-level `apiCall` block. It may stand alone (the
 * serverless integration — the tool IS the integration) or sit alongside a
 * spawned (`node`|…) or remote (`http`) `server`. `authKey` is explicit and
 * the schema guarantees it names a declared auth, so this cannot fail for a
 * validated manifest.
 */
export function getApiCallConfig(
  manifest: IntegrationManifest,
): { authKey: string; uploadProtocols: IntegrationUploadProtocol[] } | null {
  if (manifest.apiCall) {
    const { authKey } = manifest.apiCall;
    if (!manifest.auths?.[authKey]) return null;
    return {
      authKey,
      uploadProtocols: manifest.apiCall.uploadProtocols ?? [],
    };
  }
  return null;
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
 * Pure function consumed by the run-overrides panel
 * (`run-overrides-panel.tsx`) to decide which auths an agent's tool
 * selection requires connected.
 */
export function requiredAuthKeysForAgent(
  manifest: IntegrationManifest,
  agentTools: readonly string[] | undefined,
  agentScopes?: readonly string[] | undefined,
): string[] {
  const hasTools = !!agentTools && agentTools.length > 0;
  const hasScopes = !!agentScopes && agentScopes.length > 0;
  // "Active" = the agent declared a usage. MCP integrations express it via
  // selected tools; apiCall integrations expose no MCP tools,
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
  // The generic `api_call` tool isn't in `manifest.tools`; pin the auth it
  // draws from (the `apiCall` block) when selected.
  if (agentTools?.includes(API_CALL_TOOL_NAME)) {
    const cfg = getApiCallConfig(manifest);
    if (cfg && declaredAuths.includes(cfg.authKey)) out.add(cfg.authKey);
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
export function expandScopesGranted(
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
 * Scopes the agent's selected tools/scopes require on `authKey` that the
 * connection's `granted` set lacks. Combines {@link requiredScopesForAgent}
 * with {@link expandScopesGranted} (so a parent grant covers its implied
 * children) — the single source of truth for the insufficient-scopes diff
 * used by both the connection resolver and the agent-page picker.
 *
 * Scopes are an OAuth2 concept: api_key / basic / custom / oauth1 auths
 * grant access wholesale and carry no scope catalog, so an agent's declared
 * scopes can never be "missing" from such a connection. Diffing against one
 * would spuriously report every declared scope as missing (its `granted`
 * set is always empty) — so a non-oauth2 auth short-circuits to no gap.
 */
export function missingScopesForConnection(input: {
  manifest: IntegrationManifest;
  authKey: string;
  granted: readonly string[];
  agentTools: readonly string[] | undefined;
  agentScopes: readonly string[] | undefined;
}): string[] {
  if (input.manifest.auths?.[input.authKey]?.type !== "oauth2") return [];
  const required = requiredScopesForAgent(input);
  if (required.length === 0) return [];
  const expanded = new Set(expandScopesGranted(input.granted, input.manifest, input.authKey));
  return required.filter((s) => !expanded.has(s));
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
    // The generic `api_call` tool is SYNTHETIC — exposed in-process whenever the
    // integration declares an `apiCall` capability, never listed in `tools`.
    // Accept it alongside an integration's native tool catalog (it is also
    // accepted on the serverless path, where `declared` is empty and
    // enforcement is skipped).
    const apiCallAllowed = getApiCallConfig(integrationManifest) !== null;
    if (declared.size > 0) {
      for (const tool of selection.tools) {
        if (declared.has(tool)) continue;
        if (apiCallAllowed && tool === API_CALL_TOOL_NAME) continue;
        errors.push({
          field: `integrations.${selection.id}.tools`,
          code: "unknown_tool",
          message: `Tool "${tool}" is not declared by integration ${selection.id}`,
        });
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
