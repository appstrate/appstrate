// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS Integration manifest — Zod schema, TypeScript types, and the
 * install-time scope/tool helpers Appstrate builds on top of the spec.
 *
 * Appstrate fully adopts AFPS (`docs`/`afps-spec/spec.md` §2, §3.5, §7)
 * as its integration manifest format. The base schemas are imported from
 * `@afps-spec/schema` (v2) and lightly extended here with the Appstrate
 * cross-field MUST rules that AFPS leaves to the consumer (scope-catalog
 * subset, per-tool auth-key disambiguation, connect.login output gating).
 *
 * Field vocabulary is snake_case (AFPS). The integration manifest
 * itself is read as AFPS canonical snake_case only — there is no camelCase
 * reading path on this schema. Reads and writes everywhere are AFPS
 * canonical.
 *
 * SCOPE NOTE — runtime vs manifest:
 *   The MANIFEST schema below is snake_case AFPS. The PURE RUNTIME
 *   types at the bottom of this file (`ConnectionOverrides`,
 *   `ResolvedConnection`, `ConnectionResolution*`, `AgentIntegrationScopeError`)
 *   describe the connection RESOLVER's output, not serialized manifest
 *   fields, so they keep idiomatic camelCase TS.
 */

import {
  integrationManifestSchema as afpsIntegrationManifestSchema,
  type IntegrationManifest as AfpsIntegrationManifest,
} from "@afps-spec/schema";
import {
  API_CALL_TOOL_NAME as SHARED_API_CALL_TOOL_NAME,
  API_UPLOAD_TOOL_NAME as SHARED_API_UPLOAD_TOOL_NAME,
  apiCallToolNameForAuth,
  apiUploadToolNameFor as deriveApiUploadToolName,
  assertUniqueApiToolAuthTokens,
} from "@appstrate/afps-shared/api-tool-naming";
import { normaliseMcpToolBody } from "@appstrate/afps-shared/mcp-naming";
import { isToolsWildcard, TOOLS_WILDCARD, type ManifestIntegrationEntry } from "./dependencies.ts";

// ─────────────────────────────────────────────
// Appstrate vendor extension: api_call (`_meta["dev.appstrate/api"]`)
// ─────────────────────────────────────────────

/**
 * `_meta` key carrying the Appstrate-specific `api_call` capability. This is a
 * vendor extension (AFPS §10) — orthogonal to `source.kind`. Any integration
 * (`local`, `remote`, or `none`) MAY expose the credential-injecting HTTP proxy
 * by declaring one or more auths under `_meta["dev.appstrate/api"].auths`.
 *
 * Shape: `{ auths: { <authKey>: { upload_protocols?: string[] } } }`. Presence
 * of an `authKey` opts that auth into the `api_call` tool. Single opted-in auth
 * → the tool is named `api_call`; multiple → `api_call__{authToken}` per auth
 * (the raw key when short, otherwise a stable bounded alias).
 */
export const API_META_KEY = "dev.appstrate/api";

/**
 * Resumable-upload protocols an api_call auth MAY advertise under
 * `_meta["dev.appstrate/api"].auths.{key}.upload_protocols`. This is an open
 * string array of *reserved* values: producers MAY emit other
 * (reverse-DNS-qualified) values and consumers MUST tolerate them. The
 * runtime-pi upload adapters use this list to recognise the well-known
 * protocols; non-reserved values flow through as opaque strings.
 */
export const RESERVED_INTEGRATION_UPLOAD_PROTOCOLS = [
  "google-resumable",
  "s3-multipart",
  "tus",
  "ms-resumable",
] as const;
/** An upload-protocol identifier (open string; reserved values listed above). */
export type IntegrationUploadProtocol = string;

// ─────────────────────────────────────────────
// Integration manifest (AFPS + Appstrate cross-field rules)
// ─────────────────────────────────────────────

/**
 * The integration manifest validator. The base structural schema comes from
 * `@afps-spec/schema` (snake_case, `source` discriminant, RFC 8414 OAuth,
 * `_meta` extensions). The AFPS schema already enforces its own MUST rules
 * (≥1 auth, oauth2 discovery-or-endpoints, credentials.schema for
 * api_key/basic/custom, exactly-one connect login|tool, ≥1 delivery channel,
 * http exclusive of env/files).
 *
 * Appstrate layers four additional cross-field rules AFPS leaves to the
 * consumer:
 *   1. `authorized_uris` MUST be non-empty unless `allow_all_uris` is set.
 *   2. `default_scopes` ⊆ `scope_catalog` (when both declared).
 *   3. `scope_catalog[].implies` targets MUST exist in the catalog; no
 *      self-imply.
 *   4. `tools_policy.{name}.required_scopes` is a per-auth map
 *      `{ <auth_key>: string[] }`: every key MUST be a declared `auths` entry
 *      and its scopes MUST be ⊆ that auth's `scope_catalog`. Keying by auth
 *      binds scopes to an auth for consent inference only — NOT an exclusivity
 *      lock (any connected auth may serve the tool at runtime; see
 *      {@link connectableAuthKeysForAgent}).
 */
/**
 * Walk an arbitrary JSON-Schema-like object tree and emit the path of every
 * `$ref` whose string value does NOT start with `#`. Used by the §7.5 / §8.7
 * SSRF guard to forbid non-fragment `$ref` inside `credentials.schema` —
 * external `$ref` would otherwise let a malicious manifest steer the validator
 * into a network fetch at install time.
 */
function walkForNonFragmentRefs(
  node: unknown,
  path: (string | number)[],
  emit: (path: (string | number)[]) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForNonFragmentRefs(item, [...path, i], emit));
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string" && !obj.$ref.startsWith("#")) {
      emit([...path, "$ref"]);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref") continue;
      walkForNonFragmentRefs(v, [...path, k], emit);
    }
  }
}

export const integrationManifestSchema = afpsIntegrationManifestSchema.superRefine((m, ctx) => {
  const manifest = m as unknown as IntegrationManifest;
  const auths = manifest.auths ?? {};

  for (const [authKey, auth] of Object.entries(auths)) {
    // (1) authorized_uris non-empty unless allow_all_uris.
    const authorizedUris = auth.authorized_uris ?? [];
    if (authorizedUris.length === 0 && auth.allow_all_uris !== true) {
      ctx.addIssue({
        code: "custom",
        message:
          "auths.{key}.authorized_uris must declare at least one URI pattern (or set allow_all_uris)",
        path: ["auths", authKey, "authorized_uris"],
      });
    }

    // (1b) §7.5 / §8.7 SSRF guard — credentials.schema $ref MUST be a local
    // fragment-only pointer. External `$ref` would let a malicious manifest
    // trigger validator-side fetches at install/validation time.
    const credentialsSchema = (auth as { credentials?: { schema?: unknown } }).credentials?.schema;
    if (credentialsSchema && typeof credentialsSchema === "object") {
      walkForNonFragmentRefs(credentialsSchema, [], (detectedPath) => {
        ctx.addIssue({
          code: "custom",
          message:
            "Non-fragment $ref in credentials.schema is forbidden (AFPS §7.5 / §8.7 SSRF guard)",
          path: ["auths", authKey, "credentials", "schema", ...detectedPath],
        });
      });
    }

    // (1c) §7.6 install gate — `delivery.http.in` other than "header" is not
    // yet implemented by the Appstrate sidecar MITM injector (only "header"
    // dispatch exists in `packages/connect/src/afps-delivery.ts`). Rejecting
    // at install time gives manifest authors a loud error instead of a
    // silent runtime no-op.
    const httpDelivery = (auth as { delivery?: { http?: { in?: string } } }).delivery?.http;
    if (httpDelivery?.in !== undefined && httpDelivery.in !== "header") {
      ctx.addIssue({
        code: "custom",
        message: `delivery.http.in "${httpDelivery.in}" is not yet supported by the Appstrate runtime — only "header" is implemented. Track in CHANGELOG.`,
        path: ["auths", authKey, "delivery", "http", "in"],
      });
    }

    // (1d) §7.2 + §7.6 install gate — `mtls` + `delivery.http` cannot be
    // honoured: the MITM proxy terminates upstream TLS and re-fetches, so
    // there is no first-class way to drive a client-cert handshake on the
    // upstream leg. Reject at install time; the integration author should
    // use `delivery.files` to deliver the cert + key to the spawned runner
    // and let the runner's own HTTP client perform the mtls handshake.
    if (auth.type === "mtls") {
      const mtlsHttp = (auth as { delivery?: { http?: unknown } }).delivery?.http;
      if (mtlsHttp !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "mtls + delivery.http is not supported — the MITM proxy cannot perform mtls on the upstream handshake. Use delivery.files instead.",
          path: ["auths", authKey, "delivery", "http"],
        });
      }
    }

    // connect.login output gating (§7.7): a delivery.* value template may
    // only reference declared connect outputs. We only enforce the gating
    // when a declarative `login` is present (the AFPS `tool` mode declares
    // its outputs out-of-band via `produces`, which the loose schema doesn't
    // surface here).
    const login = auth.connect?.login;
    if (login) {
      const declaredOutputs = new Set(Object.keys(login.outputs ?? {}));
      if (declaredOutputs.size === 0) {
        ctx.addIssue({
          code: "custom",
          message:
            "connect.login must declare at least one `outputs` entry (the injectable result)",
          path: ["auths", authKey, "connect", "login", "outputs"],
        });
      }
      if (login.expires_in_output && !declaredOutputs.has(login.expires_in_output)) {
        ctx.addIssue({
          code: "custom",
          message: `connect.login.expires_in_output '${login.expires_in_output}' is not a declared output`,
          path: ["auths", authKey, "connect", "login", "expires_in_output"],
        });
      }
      for (const name of login.identity_outputs ?? []) {
        if (!declaredOutputs.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `connect.login.identity_outputs '${name}' is not a declared output`,
            path: ["auths", authKey, "connect", "login", "identity_outputs"],
          });
        }
      }
      // §7.7 gating: every {$credential.<field>} reference in delivery must
      // be a declared output.
      if (declaredOutputs.size > 0) {
        for (const ref of collectDeliveryCredentialRefs(auth.delivery)) {
          if (!declaredOutputs.has(ref)) {
            ctx.addIssue({
              code: "custom",
              message: `delivery references '${ref}', which is not a declared connect output — delivery.* may only reference injectable outputs (AFPS §7.7)`,
              path: ["auths", authKey, "delivery"],
            });
          }
        }
      }
    }

    // Appstrate browser executor: this is a privilege-bearing extension, so
    // validate it strictly instead of relying on AFPS's loose vendor metadata.
    // Cross-package capability/grant checks happen after concrete mcp-server
    // version resolution; these local invariants are knowable at install time.
    const connectMeta = (auth.connect as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
      "dev.appstrate/connect"
    ] as { executor?: unknown; produces?: unknown } | undefined;
    const rawExecutor = connectMeta?.executor;
    if (rawExecutor !== undefined) {
      const executorPath = [
        "auths",
        authKey,
        "connect",
        "_meta",
        "dev.appstrate/connect",
        "executor",
      ];
      if (!rawExecutor || typeof rawExecutor !== "object" || Array.isArray(rawExecutor)) {
        ctx.addIssue({
          code: "custom",
          message: "browser connect executor must be an object",
          path: executorPath,
        });
      } else {
        const executor = rawExecutor as Record<string, unknown>;
        const unknownKeys = Object.keys(executor).filter(
          (key) => key !== "kind" && key !== "session_mode",
        );
        const unknownKey = unknownKeys[0];
        if (unknownKey !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `browser connect executor contains unknown field '${unknownKey}'`,
            path: [...executorPath, unknownKey],
          });
        }
        if (executor.kind !== "browser") {
          ctx.addIssue({
            code: "custom",
            message: "connect executor kind must be 'browser'",
            path: [...executorPath, "kind"],
          });
        }
        if (executor.session_mode !== "exportable" && executor.session_mode !== "browser-bound") {
          ctx.addIssue({
            code: "custom",
            message: "browser connect session_mode must be 'exportable' or 'browser-bound'",
            path: [...executorPath, "session_mode"],
          });
        }
      }
      if (auth.connect?.tool === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "browser connect executor requires connect.tool",
          path: ["auths", authKey, "connect", "tool"],
        });
      }
      if (manifest.source?.kind !== "local") {
        ctx.addIssue({
          code: "custom",
          message: "browser connect executor requires source.kind 'local'",
          path: ["source", "kind"],
        });
      }
      if (
        (rawExecutor as { session_mode?: unknown } | undefined)?.session_mode === "exportable" &&
        (!Array.isArray(connectMeta?.produces) ||
          connectMeta.produces.length === 0 ||
          connectMeta.produces.some((value) => typeof value !== "string" || value.length === 0))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "exportable browser connect requires non-empty connect produces",
          path: ["auths", authKey, "connect", "_meta", "dev.appstrate/connect", "produces"],
        });
      }
    }

    // (2) default_scopes ⊆ scope_catalog.
    if (auth.scope_catalog && auth.default_scopes) {
      const catalog = new Set(auth.scope_catalog.map((s) => s.value));
      for (const s of auth.default_scopes) {
        if (!catalog.has(s)) {
          ctx.addIssue({
            code: "custom",
            message: `default scope "${s}" is not declared in scope_catalog`,
            path: ["auths", authKey, "default_scopes"],
          });
        }
      }
    }

    // (3) implies targets exist; no self-imply.
    if (auth.scope_catalog) {
      const catalog = new Set(auth.scope_catalog.map((s) => s.value));
      for (const entry of auth.scope_catalog) {
        for (const target of entry.implies ?? []) {
          if (target === entry.value) {
            ctx.addIssue({
              code: "custom",
              message: `scope_catalog entry "${entry.value}" cannot imply itself`,
              path: ["auths", authKey, "scope_catalog"],
            });
          } else if (!catalog.has(target)) {
            ctx.addIssue({
              code: "custom",
              message: `scope_catalog entry "${entry.value}" implies "${target}" which is not in the catalog`,
              path: ["auths", authKey, "scope_catalog"],
            });
          }
        }
      }
    }
  }

  // (4) tools_policy.{name} cross-field validation. `required_scopes` is a
  // per-auth map `{ <auth_key>: string[] }` — every key MUST be a declared
  // auth, and each auth's scopes MUST be ⊆ that auth's `scope_catalog`.
  if (manifest.tools_policy) {
    const authKeys = new Set(Object.keys(auths));
    for (const [toolName, tool] of Object.entries(manifest.tools_policy)) {
      const requiredScopes = tool.required_scopes;
      if (!requiredScopes) continue;
      for (const [authKey, scopes] of Object.entries(requiredScopes)) {
        if (!authKeys.has(authKey)) {
          ctx.addIssue({
            code: "custom",
            message: `tools_policy.${toolName}.required_scopes key "${authKey}" does not match any auths.{key}`,
            path: ["tools_policy", toolName, "required_scopes", authKey],
          });
          continue;
        }
        const auth = auths[authKey];
        if (!auth?.scope_catalog) continue;
        const catalog = new Set(auth.scope_catalog.map((s) => s.value));
        for (const s of scopes) {
          if (!catalog.has(s)) {
            ctx.addIssue({
              code: "custom",
              message: `tools_policy.${toolName}.required_scopes contains "${s}" not declared in auths.${authKey}.scope_catalog`,
              path: ["tools_policy", toolName, "required_scopes", authKey],
            });
          }
        }
      }
    }
  }

  // (5) `_meta["dev.appstrate/api"]` (api_call vendor extension): every opted-in
  // auth key MUST reference a declared `auths.{key}`, and `upload_protocols`
  // (when present) MUST be an array of non-empty strings.
  const apiMeta = (manifest as { _meta?: Record<string, unknown> })._meta?.[API_META_KEY] as
    { auths?: unknown } | undefined;
  if (apiMeta !== undefined) {
    const metaAuths = apiMeta.auths;
    if (!metaAuths || typeof metaAuths !== "object" || Array.isArray(metaAuths)) {
      ctx.addIssue({
        code: "custom",
        message: `_meta["${API_META_KEY}"].auths must be an object keyed by auth name`,
        path: ["_meta", API_META_KEY, "auths"],
      });
    } else {
      const authKeys = Object.keys(auths);
      for (const [metaAuthKey, entry] of Object.entries(metaAuths as Record<string, unknown>)) {
        if (!authKeys.includes(metaAuthKey)) {
          ctx.addIssue({
            code: "custom",
            message: `_meta["${API_META_KEY}"].auths."${metaAuthKey}" does not match any auths.{key}`,
            path: ["_meta", API_META_KEY, "auths", metaAuthKey],
          });
          continue;
        }
        const up = (entry as { upload_protocols?: unknown } | null)?.upload_protocols;
        if (up !== undefined) {
          if (!Array.isArray(up) || up.some((v) => typeof v !== "string" || v.length === 0)) {
            ctx.addIssue({
              code: "custom",
              message: `_meta["${API_META_KEY}"].auths."${metaAuthKey}".upload_protocols must be an array of non-empty strings`,
              path: ["_meta", API_META_KEY, "auths", metaAuthKey, "upload_protocols"],
            });
          }
        }
      }
      const optedInAuthKeys = Object.keys(metaAuths as Record<string, unknown>).filter((key) =>
        authKeys.includes(key),
      );
      if (optedInAuthKeys.length > 1) {
        try {
          assertUniqueApiToolAuthTokens(optedInAuthKeys);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "api tool auth-token collision",
            path: ["_meta", API_META_KEY, "auths"],
          });
        }
      }
    }
  }

  // (6) `default_tools` (AFPS §4.4) — the tool selection an agent inherits when
  // it depends on this integration but omits `integrations_configuration.<id>`.
  //   - `"*"` requires `allow_undeclared_tools: true` (same gate as an agent's
  //     wildcard selection — a default cannot grant the passthrough surface the
  //     integration author did not opt into).
  //   - an array MUST contain strings; for `source.kind: "none"` (api-only — the
  //     full catalog is knowable from this manifest alone) every entry MUST be a
  //     real catalog tool, which catches typos like `["api_calll"]`. For
  //     local/remote sources the authoritative tool list lives in the referenced
  //     mcp-server (not resolvable in a pure-manifest superRefine), so array
  //     membership is left to runtime — mirroring the agent-side leniency.
  const defaultTools = (manifest as { default_tools?: unknown }).default_tools;
  if (defaultTools !== undefined) {
    if (isToolsWildcard(defaultTools)) {
      if ((manifest as { allow_undeclared_tools?: boolean }).allow_undeclared_tools !== true) {
        ctx.addIssue({
          code: "custom",
          message:
            'default_tools "*" requires allow_undeclared_tools: true — a wildcard default cannot grant the full upstream surface unless the integration explicitly authorizes it',
          path: ["default_tools"],
        });
      }
    } else if (!Array.isArray(defaultTools) || defaultTools.some((v) => typeof v !== "string")) {
      ctx.addIssue({
        code: "custom",
        message: 'default_tools must be an array of tool names or the wildcard "*"',
        path: ["default_tools"],
      });
    } else if (manifest.source?.kind === "none") {
      const catalog = new Set(
        resolveIntegrationToolCatalog({ integration: manifest }).map((e) => e.name),
      );
      for (const name of defaultTools) {
        if (!catalog.has(canonicalizeApiToolName(manifest, name))) {
          ctx.addIssue({
            code: "custom",
            message: `default_tools contains "${name}" which is not a tool this integration exposes`,
            path: ["default_tools"],
          });
        }
      }
    }
  }
});

/**
 * The AFPS integration manifest type. Re-exported from
 * `@afps-spec/schema` (the base structural type — the Appstrate superRefine
 * above adds cross-field validation without changing the shape).
 */
export type IntegrationManifest = AfpsIntegrationManifest;

/**
 * Narrowed view of a single auth method's `delivery` (AFPS §7.6). The
 * canonical schema is `looseObject` so the fields are optional/unknown at the
 * type level; this is the subset the gating + ref-collection helpers read.
 */
interface DeliveryView {
  http?: { value?: string };
  env?: Record<string, { value?: string }>;
  files?: Record<string, { value?: string }>;
}

/** Extract `{$credential.<field>}` references from a delivery value template. */
function extractCredentialRefs(template: string | undefined): string[] {
  if (!template) return [];
  const out: string[] = [];
  const re = /\{\$credential\.([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) out.push(match[1]!);
  return out;
}

/**
 * Every credential field name a `delivery.{http,env,files}` block references
 * via a `{$credential.<field>}` template. Used to enforce the §7.7 gating
 * rule: a connect auth's delivery may only reference declared `outputs`.
 */
function collectDeliveryCredentialRefs(delivery: DeliveryView | undefined): string[] {
  if (!delivery) return [];
  const refs: string[] = [];
  refs.push(...extractCredentialRefs(delivery.http?.value));
  for (const entry of Object.values(delivery.env ?? {})) {
    refs.push(...extractCredentialRefs(entry.value));
  }
  for (const entry of Object.values(delivery.files ?? {})) {
    refs.push(...extractCredentialRefs(entry.value));
  }
  return refs;
}

// ─────────────────────────────────────────────
// Install-time helpers (niveau 2 scope model)
// ─────────────────────────────────────────────

/**
 * Tool name the generic credential-injecting capability is exposed under
 * (before the `{namespace}__` prefix the sidecar's McpHost applies). Constant
 * so the spawn resolver, the McpHost allowlist, and the agent editor agree.
 */
export const API_CALL_TOOL_NAME = SHARED_API_CALL_TOOL_NAME;

/**
 * Tool name the chunked/resumable upload capability is exposed under (before
 * the sidecar's `{namespace}__` prefix). Companion of {@link API_CALL_TOOL_NAME}:
 * the sidecar advertises it for every api_call auth whose
 * `_meta["dev.appstrate/api"].auths.{key}.upload_protocols` is non-empty, and
 * the agent-side Pi extension drives it by dispatching each chunk through the
 * sibling `api_call` tool.
 */
export const API_UPLOAD_TOOL_NAME = SHARED_API_UPLOAD_TOOL_NAME;

/**
 * Derive the `api_upload` companion name from an api_call tool name:
 * `api_call` → `api_upload`, `api_call__{authToken}` →
 * `api_upload__{authToken}`.
 * This MUST stay in lockstep with the sidecar's own derivation
 * (`runtime-pi/sidecar/mcp.ts` → `makeApiUploadTool`) so the platform catalog
 * and the runtime advertise the same pair. Runtime dispatch resolves the
 * sibling from trusted `_meta` identity within the tool's host namespace.
 */
export function apiUploadToolNameFor(apiCallToolName: string): string {
  return deriveApiUploadToolName(apiCallToolName);
}

/**
 * Names of MCP tools the integration declares POLICY for in its top-level
 * `tools_policy` record. Empty when the integration didn't opt into per-tool
 * metadata. This is NOT the catalog of exposed tools — `tools_policy` is a
 * sparse policy table. The catalog comes from
 * {@link resolveIntegrationToolCatalog}.
 */
export function getDeclaredToolNames(manifest: IntegrationManifest): string[] {
  return manifest.tools_policy ? Object.keys(manifest.tools_policy) : [];
}

/**
 * The set of auth keys a manifest currently declares — the single source for
 * the "orphaned-auth" guard. A connection whose `authKey` is not in this set
 * can never produce a delivery plan (the spawn resolver matches connection →
 * auth by key), so it must not be offered in the picker nor auto-picked at run
 * time. Returns `null` when there is NO constraint to apply — either the
 * manifest is absent/unfetchable, or it declares zero auths — so every caller
 * treats `null` as "don't filter" and the empty-auths edge can't silently drop
 * every candidate. Callers keep their own row shape; this owns the key set +
 * null semantics so the two filter sites (runtime resolver + picker verdict)
 * can't drift apart.
 */
export function manifestAuthKeySet(
  manifest: IntegrationManifest | null | undefined,
): Set<string> | null {
  if (!manifest) return null;
  const keys = Object.keys(manifest.auths ?? {});
  return keys.length === 0 ? null : new Set(keys);
}

/**
 * True when the integration declares at least one auth marked
 * `_meta["dev.appstrate/auth"].required: true`. This vendor flag (set on ~all
 * system integrations; `false` for credential-less public MCP servers like
 * github-mcp) expresses "this integration cannot operate without a connection".
 * The run connection-resolver uses it to keep such an integration ACTIVE even
 * when the agent selected no tools/scopes (otherwise the "inert" skip would let
 * the run launch without ever demanding a connection). `_meta` is preserved on
 * the parsed manifest (AFPS allows open `_meta` on auth objects).
 */
export function manifestHasRequiredAuth(manifest: IntegrationManifest | null | undefined): boolean {
  const auths = manifest?.auths ?? {};
  for (const auth of Object.values(auths)) {
    const meta =
      auth && typeof auth === "object" ? (auth as Record<string, unknown>)._meta : undefined;
    const block =
      meta && typeof meta === "object"
        ? (meta as Record<string, unknown>)["dev.appstrate/auth"]
        : undefined;
    const required =
      block && typeof block === "object" ? (block as Record<string, unknown>).required : undefined;
    if (required === true) return true;
  }
  return false;
}

/**
 * Tool names referenced as a run-start `connect.tool` across all auths.
 * Auto-hidden from the agent surface — these are credential-acquisition
 * primitives the platform invokes at boot, not agent capabilities.
 *
 * Reads `connect.tool.name` (string) — AFPS §7.7 spec-natural location.
 * `connect.tool` is the canonical block for the orchestrated-acquisition
 * mode; `name` is the tool reference.
 */
export function getConnectToolNames(manifest: IntegrationManifest): string[] {
  const names: string[] = [];
  for (const auth of Object.values(manifest.auths ?? {})) {
    const connect = (
      auth as {
        connect?: {
          tool?: { name?: unknown };
        };
      }
    ).connect;
    const specNatural = connect?.tool?.name;
    if (typeof specNatural === "string" && specNatural.length > 0) {
      names.push(specNatural);
    }
  }
  return names;
}

/**
 * Effective per-tool policy as carried in `integration.tools_policy[name]`.
 * Wire-bound (snake_case): this rides the `IntegrationDetail.tool_catalog`
 * HTTP payload verbatim and the frontend reads `policy.required_scopes`.
 */
export interface IntegrationToolPolicy {
  /** Per-auth scopes the tool requires: `{ <auth_key>: scopes[] }`. */
  required_scopes?: Readonly<Record<string, readonly string[]>>;
}

/** One entry in the resolved agent-facing tool catalog. */
export interface IntegrationToolCatalogEntry {
  name: string;
  description?: string;
  /** Present iff `integration.tools_policy[name]` declared metadata for this tool. */
  policy?: IntegrationToolPolicy;
}

export interface ResolveIntegrationToolCatalogInput {
  integration: IntegrationManifest;
  /**
   * Verbatim MCPB `tools[]` from the referenced mcp-server (local source
   * only). Pass `undefined` for remote/api sources or when the mcp-server
   * manifest is unavailable — the resolver then falls back to
   * `integration.tools_policy` keys.
   */
  mcpServerTools?: ReadonlyArray<{ name: string; description?: string }>;
}

/**
 * Single source of truth for what the agent's picker sees and what
 * `tools/list` exposes at runtime. Resolution:
 *
 *   1. Base catalog (the integration's own surface)
 *      - local + mcpServerTools provided → MCPB-canonical entries
 *      - otherwise          → `integration.tools_policy` keys (sparse fallback)
 *   1b. Append api_call tool(s) from `_meta["dev.appstrate/api"]` (additive —
 *       orthogonal to source kind; a `none` source contributes only these),
 *       each with its `api_upload` companion when the auth declared
 *       `upload_protocols`
 *   2. Subtract `integration.hidden_tools` (explicit opt-out). Hiding an
 *      `api_call` also hides its dependent `api_upload` companion; hiding the
 *      companion alone leaves `api_call` available.
 *   3. Subtract `getConnectToolNames` (auto-hide run-start primitives)
 *   4. Attach policy from `integration.tools_policy[name]` when present
 */
export function resolveIntegrationToolCatalog(
  input: ResolveIntegrationToolCatalogInput,
): IntegrationToolCatalogEntry[] {
  const { integration, mcpServerTools } = input;

  // Step 1 — the integration's own MCP catalog
  let base: IntegrationToolCatalogEntry[];
  if (mcpServerTools && mcpServerTools.length > 0) {
    base = mcpServerTools.map((t) => ({ name: t.name, description: t.description }));
  } else {
    base = getDeclaredToolNames(integration).map((name) => ({ name }));
  }

  // Step 1b — append api_call tool(s) (vendor extension, additive), each
  // followed by its `api_upload` companion when the auth declared
  // `upload_protocols`. The companion is what the sidecar actually advertises
  // (`makeApiUploadTool`), so omitting it here would leave the catalog — and
  // therefore the picker and the agent-import validator — narrower than the
  // runtime surface.
  const apiCallConfigs = getApiCallConfigs(integration);
  const syntheticApiEntries = apiCallConfigs.flatMap((config) =>
    config.uploadToolName
      ? [{ name: config.toolName }, { name: config.uploadToolName }]
      : [{ name: config.toolName }],
  );
  const syntheticApiNames = new Set(syntheticApiEntries.map((entry) => entry.name));
  for (const config of apiCallConfigs) {
    if (config.legacyToolName) syntheticApiNames.add(config.legacyToolName);
    if (config.legacyUploadToolName) syntheticApiNames.add(config.legacyUploadToolName);
  }
  // Synthetic capability names (including persisted long-key aliases) are
  // reserved only when the integration opts into that exact capability. Give
  // the trusted surface canonical precedence over a same-named native MCP tool
  // instead of advertising an ambiguous duplicate or an unselectable `_2`.
  base = [
    ...base.filter(
      (entry) =>
        !syntheticApiNames.has(entry.name) &&
        !syntheticApiNames.has(normaliseMcpToolBody(entry.name)),
    ),
    ...syntheticApiEntries,
  ];

  // Step 2+3 — hide set (explicit + auto)
  const hidden = new Set<string>([
    ...(integration.hidden_tools ?? []),
    ...getConnectToolNames(integration),
  ]);
  // `api_upload` cannot execute without its sibling `api_call`: every chunk is
  // dispatched through that credential-proxy tool. Preserve the useful
  // asymmetric opt-out (authors may hide upload while keeping generic calls),
  // but never leave an orphan upload in the catalog when its dependency is
  // hidden.
  for (const config of apiCallConfigs) {
    const callHidden =
      hidden.has(config.toolName) ||
      (config.legacyToolName !== undefined && hidden.has(config.legacyToolName));
    const uploadHidden =
      config.uploadToolName !== undefined &&
      (hidden.has(config.uploadToolName) ||
        (config.legacyUploadToolName !== undefined && hidden.has(config.legacyUploadToolName)));
    if (callHidden) hidden.add(config.toolName);
    if (config.uploadToolName && (callHidden || uploadHidden)) {
      hidden.add(config.uploadToolName);
    }
  }

  // Step 4 — attach policy from the sparse `tools_policy{}` table
  const policyTable = integration.tools_policy ?? {};
  const out: IntegrationToolCatalogEntry[] = [];
  for (const entry of base) {
    if (hidden.has(entry.name)) continue;
    const raw = policyTable[entry.name];
    if (!raw) {
      out.push(entry);
      continue;
    }
    out.push({
      ...entry,
      policy: {
        required_scopes: raw.required_scopes as IntegrationToolPolicy["required_scopes"],
      },
    });
  }
  return out;
}

/** One resolved `api_call` capability — a single opted-in auth. */
export interface ApiCallConfig {
  /** The `auths.{key}` whose credential this api_call tool injects. */
  authKey: string;
  /**
   * Agent-facing tool name (before the sidecar's `{namespace}__` prefix).
   * `api_call` when the integration opts in exactly one auth;
   * `api_call__{authToken}` when it opts in several.
   */
  toolName: string;
  /**
   * Pre-bounding `api_call__{authKey}` name accepted for manifests/selections
   * persisted before long auth keys gained a transport-safe canonical token.
   * Present only when it differs from {@link ApiCallConfig.toolName}.
   */
  legacyToolName?: string;
  /** Resumable upload protocols this auth's surface supports (open list). */
  uploadProtocols: IntegrationUploadProtocol[];
  /**
   * Agent-facing name of the `api_upload` companion tool, present iff
   * {@link ApiCallConfig.uploadProtocols} is non-empty — i.e. exactly when the
   * sidecar advertises it. Absent otherwise, so callers never surface a tool
   * the runtime won't serve.
   */
  uploadToolName?: string;
  /** Legacy upload alias corresponding to {@link ApiCallConfig.legacyToolName}. */
  legacyUploadToolName?: string;
}

/** Read `_meta["dev.appstrate/api"].auths` as a raw record (or undefined). */
function readApiMetaAuths(
  manifest: IntegrationManifest,
): Record<string, { upload_protocols?: unknown } | null> | undefined {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const api = meta?.[API_META_KEY] as { auths?: unknown } | undefined;
  const auths = api?.auths;
  if (!auths || typeof auths !== "object" || Array.isArray(auths)) return undefined;
  return auths as Record<string, { upload_protocols?: unknown } | null>;
}

/**
 * Resolve every `api_call` capability an integration exposes, driven entirely
 * by the `_meta["dev.appstrate/api"].auths` vendor extension — orthogonal to
 * `source.kind`, so an integration with a `local`/`remote` MCP server can ALSO
 * expose api_call. Returns `[]` when the integration declares none.
 *
 * Each opted-in auth must reference a declared `auths.{key}`; unknown keys are
 * skipped (the install-time superRefine rejects them, so this is defence in
 * depth for already-stored manifests). Tool naming: a single opted-in auth →
 * `api_call`; multiple → an auth-scoped `api_call__{token}` per auth. Short
 * auth keys remain verbatim; long AFPS-valid keys use a stable bounded token
 * so the fully namespaced MCP name never exceeds the transport limit.
 */
export function getApiCallConfigs(manifest: IntegrationManifest): ApiCallConfig[] {
  const metaAuths = readApiMetaAuths(manifest);
  if (!metaAuths) return [];
  const declaredAuths = manifest.auths ?? {};
  const authKeys = Object.keys(metaAuths).filter((k) => k in declaredAuths);
  if (authKeys.length === 0) return [];
  const single = authKeys.length === 1;
  if (!single) {
    try {
      assertUniqueApiToolAuthTokens(authKeys);
    } catch {
      // The install-time schema reports the exact collision. Already-stored or
      // hand-constructed manifests fail closed by exposing no synthetic tools.
      return [];
    }
  }
  return authKeys.map((authKey) => {
    const raw = metaAuths[authKey]?.upload_protocols;
    const uploadProtocols = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    const legacyToolName = single ? API_CALL_TOOL_NAME : `${API_CALL_TOOL_NAME}__${authKey}`;
    const toolName = apiCallToolNameForAuth(authKey, !single);
    const uploadToolName = uploadProtocols.length > 0 ? apiUploadToolNameFor(toolName) : undefined;
    const legacyUploadToolName =
      uploadProtocols.length > 0 ? apiUploadToolNameFor(legacyToolName) : undefined;
    return {
      authKey,
      toolName,
      ...(legacyToolName !== toolName ? { legacyToolName } : {}),
      uploadProtocols,
      ...(uploadToolName ? { uploadToolName } : {}),
      ...(legacyUploadToolName && legacyUploadToolName !== uploadToolName
        ? { legacyUploadToolName }
        : {}),
    };
  });
}

/**
 * Canonicalise a persisted synthetic API tool name without touching native
 * tool names. Long multi-auth names used to embed the full auth key; accept
 * those aliases indefinitely, but emit only the bounded canonical form.
 */
export function canonicalizeApiToolName(manifest: IntegrationManifest, name: string): string {
  for (const config of getApiCallConfigs(manifest)) {
    if (name === config.legacyToolName) return config.toolName;
    if (name === config.legacyUploadToolName && config.uploadToolName) {
      return config.uploadToolName;
    }
  }
  return name;
}

/**
 * Read the integration's declared `default_tools` (AFPS §4.4 — the tools an
 * agent inherits when it depends on the integration but omits
 * `integrations_configuration.<id>` or omits its `tools`). This is a loose
 * field on the integration manifest (validated by {@link integrationManifestSchema}
 * but not yet part of the base structural type), so it is read via a narrowed
 * cast. Returns the wildcard literal `"*"`, a string array, or `undefined` when
 * absent / malformed (defence in depth — the install-time superRefine already
 * rejects malformed values).
 */
export function readDefaultTools(
  manifest: IntegrationManifest,
): readonly string[] | "*" | undefined {
  const raw = (manifest as { default_tools?: unknown }).default_tools;
  if (isToolsWildcard(raw)) return TOOLS_WILDCARD;
  if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw as string[];
  return undefined;
}

/**
 * Resolve the effective per-integration tool selection for an agent. An
 * explicit agent selection — including an empty array (`[]`, "use zero tools")
 * and the wildcard (`"*"`) — always wins. Only when the agent declared NO
 * selection (`undefined`: no `integrations_configuration.<id>` entry, or one
 * without `tools`) does the integration's declared {@link readDefaultTools}
 * default apply.
 *
 * Precedence: explicit `[]`/`["…"]`/`"*"` ⟶ as-is; `undefined` ⟶ integration
 * `default_tools` (or `undefined` if the integration declares none).
 *
 * Applied once at every site that consumes the agent's tool selection (spawn
 * resolution AND OAuth scope inference) so the default is honoured uniformly.
 */
export function resolveEffectiveToolSelection(
  agentSelection: readonly string[] | "*" | undefined,
  manifest: IntegrationManifest,
): readonly string[] | "*" | undefined {
  if (agentSelection !== undefined) return agentSelection;
  return readDefaultTools(manifest);
}

/**
 * True when `name` is an api_call tool name — the bare `api_call` or a
 * per-auth `api_call__{authToken}` variant. Used to recognise api_call selections
 * that never appear in `tools_policy`.
 */
export function isApiCallToolName(name: string): boolean {
  return name === API_CALL_TOOL_NAME || name.startsWith(`${API_CALL_TOOL_NAME}__`);
}

/**
 * True when `name` is an api_upload tool name — the bare `api_upload` or a
 * per-auth `api_upload__{authToken}` variant. Like {@link isApiCallToolName},
 * these never appear in `tools_policy`: they are derived from the
 * `_meta["dev.appstrate/api"]` extension, not declared.
 */
export function isApiUploadToolName(name: string): boolean {
  return name === API_UPLOAD_TOOL_NAME || name.startsWith(`${API_UPLOAD_TOOL_NAME}__`);
}

/**
 * Which auth keys a connection COULD satisfy for the agent's tool selection —
 * the candidate set for a connection *picker* (run/schedule override UI). It
 * returns the auths a connection MAY satisfy, as opposed to the auths that
 * MUST be connected (install-gating, OAuth scope union, runtime resolver).
 *
 * `tools_policy.{tool}.required_scopes` only *binds a tool's scopes to an auth*
 * (per-auth map) for consent inference — it is NOT an exclusivity lock. No
 * tool→auth hard-lock is modelled today, so any declared auth (e.g. a `pat`
 * alternative alongside `oauth`) can serve any selected tool. The picker must
 * therefore offer every declared auth, not just a scope-referenced one.
 *
 * An integration that exposes `api_call` ({@link getApiCallConfigs}) is its own
 * selection signal: the agent consumes it through `api_call` with an explicit
 * `auth_key` pin, so it has no MCP tools/scopes to select yet still needs a
 * connection (e.g. a `source.kind: "none"` REST integration). Returns `[]`
 * only when the agent picked zero tools, zero scopes AND the integration
 * exposes no api_call (genuinely declared-but-inert).
 */
export function connectableAuthKeysForAgent(
  manifest: IntegrationManifest,
  agentTools: readonly string[] | "*" | undefined,
  agentScopes?: readonly string[] | undefined,
): string[] {
  const hasSelection =
    isToolsWildcard(agentTools) ||
    (Array.isArray(agentTools) && agentTools.length > 0) ||
    (agentScopes?.length ?? 0) > 0 ||
    getApiCallConfigs(manifest).length > 0;
  if (!hasSelection) return [];
  return manifest.auths ? Object.keys(manifest.auths) : [];
}

/**
 * Required oauth scopes for an agent's use of (integration, authKey): the
 * union of tool-inferred scopes ({@link scopesContributedByTools}) and the
 * agent's explicitly-selected scopes.
 *
 * Wildcard path: when `agentTools === "*"` (AFPS §4.4 wildcard, requires
 * the integration's `allow_undeclared_tools: true`), per-tool inference is
 * bypassed and the selected auth's `default_scopes` (§7.4) is used as the
 * baseline, still unioned with any explicit `agentScopes`.
 */
export function requiredScopesForAgent(input: {
  manifest: IntegrationManifest;
  authKey: string;
  agentTools: readonly string[] | "*" | undefined;
  agentScopes: readonly string[] | undefined;
}): string[] {
  const viaExplicit = input.agentScopes ? [...input.agentScopes] : [];
  if (isToolsWildcard(input.agentTools)) {
    const defaultScopes = input.manifest.auths?.[input.authKey]?.default_scopes ?? [];
    return [...new Set([...defaultScopes, ...viaExplicit])];
  }
  const viaTools = scopesContributedByTools({
    manifest: input.manifest,
    authKey: input.authKey,
    agentTools: input.agentTools,
  });
  return [...new Set([...viaTools, ...viaExplicit])];
}

/**
 * Union of `required_scopes[authKey]` across the agent's selected tools — the
 * scopes the given auth must be granted for the selected tools. With the
 * per-auth `required_scopes` map this is a direct lookup by `authKey`; tools
 * that declare no scopes under `authKey` contribute nothing. Returns `[]` when
 * the agent picked zero tools. The wildcard form (`"*"`) is handled by
 * {@link requiredScopesForAgent}; this helper sees the array form only.
 */
export function scopesContributedByTools(input: {
  manifest: IntegrationManifest;
  authKey: string;
  agentTools: readonly string[] | undefined;
}): string[] {
  if (!input.agentTools || input.agentTools.length === 0) return [];
  const toolsRecord = input.manifest.tools_policy;
  if (!toolsRecord) return [];

  const out = new Set<string>();
  for (const toolName of input.agentTools) {
    const scopesForAuth = toolsRecord[toolName]?.required_scopes?.[input.authKey];
    if (!scopesForAuth) continue;
    for (const s of scopesForAuth) out.add(s);
  }
  return [...out];
}

/**
 * Expand granted OAuth scopes through the manifest's `scope_catalog[].implies`
 * hierarchy so a parent grant doesn't appear to be missing its narrower
 * children when computing insufficient-scopes diffs.
 */
export function expandScopesGranted(
  granted: readonly string[],
  manifest: IntegrationManifest,
  authKey: string,
): string[] {
  const catalog = manifest.auths?.[authKey]?.scope_catalog ?? [];
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
 * connection's `granted` set lacks. Non-oauth2 auths short-circuit to no gap
 * (they grant access wholesale and carry no scope catalog).
 */
export function missingScopesForConnection(input: {
  manifest: IntegrationManifest;
  authKey: string;
  granted: readonly string[];
  agentTools: readonly string[] | "*" | undefined;
  agentScopes: readonly string[] | undefined;
}): string[] {
  if (input.manifest.auths?.[input.authKey]?.type !== "oauth2") return [];
  const required = requiredScopesForAgent(input);
  if (required.length === 0) return [];
  const expanded = new Set(expandScopesGranted(input.granted, input.manifest, input.authKey));
  return required.filter((s) => !expanded.has(s));
}

/**
 * Union of every OAuth scope advertised across the integration's auths'
 * `scope_catalog`s. Returns `[]` when no auth declares a catalog (the caller
 * then skips catalog enforcement).
 */
export function getAvailableScopes(manifest: IntegrationManifest): readonly string[] {
  if (!manifest.auths) return [];
  const out = new Set<string>();
  for (const auth of Object.values(manifest.auths)) {
    if (auth.scope_catalog) {
      for (const s of auth.scope_catalog) out.add(s.value);
    }
  }
  return [...out];
}

/** Structured validation error returned by {@link validateAgentIntegrationScopes}. */
export interface AgentIntegrationScopeError {
  /** Dotted JSON path into the agent manifest (`integrations.<id>.<field>`). */
  field: string;
  /** Stable machine-readable code consumed by route layer / UI. */
  code: "unknown_tool" | "scope_not_in_catalog" | "wildcard_not_authorized";
  /** Human-readable detail for surfaces that don't translate `code`. */
  message: string;
}

/**
 * Validate an agent's tool/scope selection against the integration's
 * effective tool catalog and scope_catalog. Returns an array of structured
 * errors — empty means install-valid.
 *
 * Tool validation uses {@link resolveIntegrationToolCatalog} so it sees the
 * MCPB-canonical mcp-server tools (when `mcpServerTools` is passed) rather
 * than the sparse `integration.tools` policy table. Pass `mcpServerTools`
 * for local-source integrations; omit it for remote/api sources or when
 * the mcp-server manifest is unavailable (the resolver falls back to
 * `integration.tools` keys).
 *
 * Default semantics:
 *   - Empty resolved catalog → no tool validation (caller is responsible
 *     for surfacing "no exposable tools").
 *   - No `scope_catalog` on any auth → any scope accepted (the IdP is the
 *     ultimate authority at consent time).
 */
export function validateAgentIntegrationScopes(
  selection: Pick<ManifestIntegrationEntry, "id" | "tools" | "scopes">,
  integrationManifest: IntegrationManifest,
  mcpServerTools?: ResolveIntegrationToolCatalogInput["mcpServerTools"],
): AgentIntegrationScopeError[] {
  const errors: AgentIntegrationScopeError[] = [];

  if (isToolsWildcard(selection.tools)) {
    // AFPS §4.4 wildcard — the agent opts into every upstream tool. Only
    // valid when the integration explicitly authorizes the pass-through
    // via `allow_undeclared_tools: true` (§7.8). The integration schema
    // already enforces that this flag requires ≥1 auth with non-empty
    // `default_scopes`, so the scope set is well-defined at this point.
    if (
      (integrationManifest as { allow_undeclared_tools?: boolean }).allow_undeclared_tools !== true
    ) {
      errors.push({
        field: `integrations_configuration.${selection.id}.tools`,
        code: "wildcard_not_authorized",
        message: `Integration ${selection.id} does not declare allow_undeclared_tools: true — wildcard tools "*" is not permitted`,
      });
    }
  } else if (selection.tools && selection.tools.length > 0) {
    const catalog = resolveIntegrationToolCatalog({
      integration: integrationManifest,
      mcpServerTools,
    });
    if (catalog.length > 0) {
      const allowed = new Set(catalog.map((e) => e.name));
      for (const tool of selection.tools) {
        if (allowed.has(canonicalizeApiToolName(integrationManifest, tool))) continue;
        errors.push({
          field: `integrations_configuration.${selection.id}.tools`,
          code: "unknown_tool",
          message: `Tool "${tool}" is not exposed by integration ${selection.id}`,
        });
      }
    }
  }

  if (selection.scopes && selection.scopes.length > 0) {
    const catalog = getAvailableScopes(integrationManifest);
    if (catalog.length > 0) {
      const catalogSet = new Set(catalog);
      for (const scope of selection.scopes) {
        if (!catalogSet.has(scope)) {
          errors.push({
            field: `integrations_configuration.${selection.id}.scopes`,
            code: "scope_not_in_catalog",
            message: `Scope "${scope}" is not declared in scope_catalog of integration ${selection.id}`,
          });
        }
      }
    }
  }

  return errors;
}

// ────────────────────────────────────────────────────────────────────
// Flat connection model — PURE RUNTIME types (camelCase, NOT manifest
// fields). Consumed by the integration connection resolver
// (apps/api/src/services/integration-connection-resolver.ts). These describe
// resolver output, not the AFPS manifest, so they stay idiomatic TS.
// ────────────────────────────────────────────────────────────────────

/**
 * Per-integration connection picks. Used on `runs.connection_overrides`
 * (caller's run-time choice) and `package_schedules.connection_overrides`
 * (frozen at schedule create). Shape: `{ "@scope/integration": "<connection_id>" }`.
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
  /**
   * Connection label + account identifier, denormalized at run kickoff so the
   * run's "connexions utilisées" panel survives the connection being renamed
   * or deleted (same rationale as `runs.agent_scope`/`agent_name`). Absent on
   * runs created before this snapshot existed.
   */
  label?: string | null;
  accountId?: string | null;
}

/**
 * Snapshot of the resolver output for one run. Persisted on
 * `runs.resolved_connections`. Shape: `{ "@scope/integration": ResolvedConnection }`.
 */
export type ResolvedConnectionMap = Record<string, ResolvedConnection>;

/** Error codes the resolver emits per integration. */
export type ConnectionResolutionErrorCode =
  | "not_connected"
  | "needs_reconnection"
  | "pinned_connection_unavailable"
  | "override_connection_unavailable"
  | "must_choose_connection"
  | "insufficient_scopes"
  | "auth_key_mismatch";

/** One unresolved integration plus structured detail. */
export interface ConnectionResolutionError {
  integrationId: string;
  code: ConnectionResolutionErrorCode;
  /** Candidate connection ids when `code === "must_choose_connection"`. */
  candidateConnectionIds?: string[];
  /**
   * The connection the error is bound to:
   *   - `insufficient_scopes` → the under-scoped connection (target of OAuth upgrade).
   *   - `needs_reconnection` → the dead connection (target of OAuth reconnect).
   * Threaded into the OAuth re-kickoff `state` so the callback UPDATEs the
   * existing row instead of INSERTing a duplicate (integration-connections.ts
   * "explicit connectionId = update; no id = insert").
   */
  connectionId?: string;
  /** Scopes the agent needs that the connection lacks (insufficient_scopes). */
  missingScopes?: string[];
  /**
   * The cascade layer that resolved the (failing) connection, when the error
   * is bound to a specific connection (`insufficient_scopes`). Lets callers
   * derive the pick status directly instead of re-comparing `connectionId`
   * against re-fetched pin ids.
   */
  source?: ConnectionResolutionSource;
  /** True when the resolved connection belongs to the current actor. */
  ownedByActor?: boolean;
  /**
   * AFPS §4.1 — agent dep's pinned `auth_key` when
   * `code === "auth_key_mismatch"`.
   */
  requiredAuthKey?: string;
  /**
   * The `auth_key` values present on the actor's candidate connections
   * for this integration when `code === "auth_key_mismatch"`. Empty when
   * the actor has no connections at all on this integration.
   */
  availableAuthKeys?: string[];
  message: string;
}

/** Full resolver output. */
export interface ConnectionResolutionResult {
  resolved: ResolvedConnectionMap;
  errors: ConnectionResolutionError[];
}
