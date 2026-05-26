// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS 2.0 Integration manifest — Zod schema, TypeScript types, and the
 * install-time scope/tool helpers Appstrate builds on top of the spec.
 *
 * Appstrate fully adopts AFPS 2.0 (`docs`/`afps-spec/spec.md` §2, §3.5, §7)
 * as its integration manifest format. The base schemas are imported from
 * `@afps-spec/schema` (v2) and lightly extended here with the Appstrate
 * cross-field MUST rules that AFPS leaves to the consumer (scope-catalog
 * subset, per-tool auth-key disambiguation, connect.login output gating).
 *
 * Field vocabulary is snake_case (§Appendix D). Appstrate is AFPS 2.0 only —
 * there is no 1.x camelCase reading path.
 *
 * SCOPE NOTE — runtime vs manifest:
 *   The MANIFEST schema below is snake_case AFPS 2.0. The PURE RUNTIME
 *   types at the bottom of this file (`ConnectionOverrides`,
 *   `ResolvedConnection`, `ConnectionResolution*`, `AgentIntegrationScopeError`)
 *   describe the connection RESOLVER's output, not serialized manifest
 *   fields, so they keep idiomatic camelCase TS.
 */

import {
  integrationManifestSchema as afpsIntegrationManifestSchema,
  RESERVED_UPLOAD_PROTOCOLS,
  type IntegrationManifest as AfpsIntegrationManifest,
} from "@afps-spec/schema";
import type { ManifestIntegrationEntry } from "./dependencies.ts";

// ─────────────────────────────────────────────
// Re-exports of AFPS 2.0 primitives consumed elsewhere
// ─────────────────────────────────────────────

/**
 * Resumable-upload protocols an `api`-source integration MAY advertise
 * (`source.api.upload_protocols`, AFPS §7.1 / §7.5). AFPS 2.0.2 dropped the
 * closed enum in favour of an open string array of *reserved* values:
 * producers MAY emit other (reverse-DNS-qualified) values and consumers MUST
 * tolerate them. The runtime-pi upload adapters use this list to recognise
 * the well-known protocols; non-reserved values flow through as opaque
 * strings.
 */
export const RESERVED_INTEGRATION_UPLOAD_PROTOCOLS = RESERVED_UPLOAD_PROTOCOLS;
/**
 * @deprecated AFPS 2.0.2 replaced the closed enum with an open string array.
 * The type is now `string` and the constant {@link RESERVED_INTEGRATION_UPLOAD_PROTOCOLS}
 * lists the values reserved by the spec. Kept as a back-compat alias for
 * downstream consumers; will be removed in a follow-up phase.
 */
export type IntegrationUploadProtocol = string;

// ─────────────────────────────────────────────
// Integration manifest (AFPS 2.0 + Appstrate cross-field rules)
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
 *   4. `tools_policy.{name}.required_auth_key` MUST match an `auths` key, and
 *      `required_scopes` ⊆ the targeted auth's `scope_catalog`; a tool that
 *      declares `required_scopes` on a multi-auth integration MUST disambiguate
 *      with `required_auth_key`.
 */
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

  // (4) tools_policy.{name} cross-field validation.
  if (manifest.tools_policy) {
    const authKeys = Object.keys(auths);
    for (const [toolName, tool] of Object.entries(manifest.tools_policy)) {
      let targetAuthKey: string | undefined;
      if (tool.required_auth_key) {
        if (!authKeys.includes(tool.required_auth_key)) {
          ctx.addIssue({
            code: "custom",
            message: `tools_policy.${toolName}.required_auth_key "${tool.required_auth_key}" does not match any auths.{key}`,
            path: ["tools_policy", toolName, "required_auth_key"],
          });
          continue;
        }
        targetAuthKey = tool.required_auth_key;
      } else if (authKeys.length === 1) {
        targetAuthKey = authKeys[0];
      } else if (authKeys.length > 1 && tool.required_scopes && tool.required_scopes.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `tools_policy.${toolName}.required_scopes declared but the integration has multiple auths; add required_auth_key to disambiguate`,
          path: ["tools_policy", toolName, "required_auth_key"],
        });
        continue;
      }

      if (targetAuthKey && tool.required_scopes && tool.required_scopes.length > 0) {
        const auth = auths[targetAuthKey];
        if (auth?.scope_catalog) {
          const catalog = new Set(auth.scope_catalog.map((s) => s.value));
          for (const s of tool.required_scopes) {
            if (!catalog.has(s)) {
              ctx.addIssue({
                code: "custom",
                message: `tools_policy.${toolName}.required_scopes contains "${s}" not declared in auths.${targetAuthKey}.scope_catalog`,
                path: ["tools_policy", toolName, "required_scopes"],
              });
            }
          }
        }
      }
    }
  }
});

/**
 * The AFPS 2.0 integration manifest type. Re-exported from
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
export const API_CALL_TOOL_NAME = "api_call";

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

/** The `_meta` key carrying Appstrate's connect-tool extension on an auth's connect block. */
export const APPSTRATE_CONNECT_META_KEY = "dev.appstrate/connect";

/**
 * Tool names referenced as a run-start `connect.tool` across all auths.
 * Auto-hidden from the agent surface — these are credential-acquisition
 * primitives the platform invokes at boot, not agent capabilities.
 *
 * Reads two locations in this priority order:
 *   1. `connect.tool.name` (string) — AFPS 2.0 §7.7 spec-natural location.
 *      `connect.tool` is the canonical block for the orchestrated-acquisition
 *      mode; `name` is the tool reference. Preferred form for new manifests.
 *   2. `connect._meta["dev.appstrate/connect"].tool` — legacy vendor-extension
 *      location used before the spec-natural `connect.tool.name` shape was
 *      adopted. Kept for back-compat so older published manifests keep
 *      auto-hiding their connect tool.
 */
export function getConnectToolNames(manifest: IntegrationManifest): string[] {
  const names: string[] = [];
  for (const auth of Object.values(manifest.auths ?? {})) {
    const connect = (
      auth as {
        connect?: {
          tool?: { name?: unknown };
          _meta?: Record<string, { tool?: unknown }>;
        };
      }
    ).connect;
    // (1) spec-natural — `connect.tool.name`
    const specNatural = connect?.tool?.name;
    if (typeof specNatural === "string" && specNatural.length > 0) {
      names.push(specNatural);
      continue;
    }
    // (2) legacy vendor extension — `connect._meta["dev.appstrate/connect"].tool`
    const meta = connect?._meta?.[APPSTRATE_CONNECT_META_KEY];
    const t = meta?.tool;
    if (typeof t === "string" && t.length > 0) names.push(t);
  }
  return names;
}

/** Effective per-tool policy as carried in `integration.tools_policy[name]`. */
export interface IntegrationToolPolicy {
  requiredScopes?: readonly string[];
  requiredAuthKey?: string;
  urlPatterns?: ReadonlyArray<{ pattern: string; methods?: readonly string[] }>;
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
 *   1. Base catalog
 *      - api source        → synthetic `[api_call]`
 *      - local + mcpServerTools provided → MCPB-canonical entries
 *      - otherwise          → `integration.tools_policy` keys (sparse fallback)
 *   2. Subtract `integration.hidden_tools` (explicit opt-out)
 *   3. Subtract `getConnectToolNames` (auto-hide run-start primitives)
 *   4. Attach policy from `integration.tools_policy[name]` when present
 */
export function resolveIntegrationToolCatalog(
  input: ResolveIntegrationToolCatalogInput,
): IntegrationToolCatalogEntry[] {
  const { integration, mcpServerTools } = input;
  const apiCallCfg = getApiCallConfig(integration);

  // Step 1 — base catalog
  let base: IntegrationToolCatalogEntry[];
  if (apiCallCfg !== null) {
    base = [{ name: API_CALL_TOOL_NAME }];
  } else if (mcpServerTools && mcpServerTools.length > 0) {
    base = mcpServerTools.map((t) => ({ name: t.name, description: t.description }));
  } else {
    base = getDeclaredToolNames(integration).map((name) => ({ name }));
  }

  // Step 2+3 — hide set (explicit + auto)
  const hidden = new Set<string>([
    ...(integration.hidden_tools ?? []),
    ...getConnectToolNames(integration),
  ]);

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
        requiredScopes: raw.required_scopes as readonly string[] | undefined,
        requiredAuthKey: raw.required_auth_key as string | undefined,
        urlPatterns: raw.url_patterns as IntegrationToolPolicy["urlPatterns"],
      },
    });
  }
  return out;
}

/**
 * Resolve the effective `api_call` configuration for an integration, or
 * `null` when the integration is not an `api`-source integration.
 *
 * AFPS 2.0 models the serverless credential-injecting surface as
 * `source.kind: "api"`. The single declared auth supplies the credential and
 * URL allowlist. `upload_protocols` is now `source.api.upload_protocols`
 * (was the old `apiCall.uploadProtocols`).
 *
 * NOTE — the old `apiCall.authKey` was an explicit auth pointer. AFPS 2.0
 * has no per-source auth pointer: an `api`-source integration draws from its
 * (typically single) declared auth. When the integration declares exactly one
 * auth we return it; when it declares several we return the first key
 * (callers needing disambiguation use `tools.{name}.required_auth_key`). The
 * export name is kept stable for consumers; "api call config" now means "the
 * api-source credential surface".
 */
export function getApiCallConfig(
  manifest: IntegrationManifest,
): { authKey: string; uploadProtocols: IntegrationUploadProtocol[] } | null {
  const source = manifest.source as { kind?: string; api?: { upload_protocols?: string[] } };
  if (source?.kind !== "api") return null;
  const authKeys = manifest.auths ? Object.keys(manifest.auths) : [];
  if (authKeys.length === 0) return null;
  return {
    authKey: authKeys[0]!,
    uploadProtocols: (source.api?.upload_protocols ?? []) as IntegrationUploadProtocol[],
  };
}

/**
 * URL patterns a single tool will reach upstream, looked up against
 * `tools_policy.{name}.url_patterns`. Returns `undefined` when the tool isn't
 * declared or didn't declare patterns. The distinction between "no entry" and
 * "empty array" matters: an explicit empty array means "tool talks to
 * nothing".
 */
export function getToolUrlPatterns(
  manifest: IntegrationManifest,
  toolName: string,
): ReadonlyArray<{ pattern: string; methods?: readonly string[] }> | undefined {
  return manifest.tools_policy?.[toolName]?.url_patterns as
    | ReadonlyArray<{ pattern: string; methods?: readonly string[] }>
    | undefined;
}

/**
 * Which auth keys an agent actually needs connected, given its declared
 * `tools[]` selection on the integration. Returns `[]` when the agent picked
 * zero tools and zero scopes — the integration is then declared-but-inert and
 * no connection is required at run-kickoff.
 */
export function requiredAuthKeysForAgent(
  manifest: IntegrationManifest,
  agentTools: readonly string[] | undefined,
  agentScopes?: readonly string[] | undefined,
): string[] {
  const hasTools = !!agentTools && agentTools.length > 0;
  const hasScopes = !!agentScopes && agentScopes.length > 0;
  if (!hasTools && !hasScopes) return [];
  const declaredAuths = manifest.auths ? Object.keys(manifest.auths) : [];
  if (declaredAuths.length === 0) return [];
  if (declaredAuths.length === 1) return declaredAuths;

  const toolsRecord = manifest.tools_policy ?? {};
  const out = new Set<string>();
  for (const toolName of agentTools ?? []) {
    const tool = toolsRecord[toolName];
    if (!tool || typeof tool.required_auth_key !== "string") continue;
    if (declaredAuths.includes(tool.required_auth_key)) out.add(tool.required_auth_key);
  }
  // The generic `api_call` tool isn't in `manifest.tools_policy`; pin the auth
  // it draws from (the api source) when selected.
  if (agentTools?.includes(API_CALL_TOOL_NAME)) {
    const cfg = getApiCallConfig(manifest);
    if (cfg && declaredAuths.includes(cfg.authKey)) out.add(cfg.authKey);
  }
  // Scope-only selection maps each selected scope to the auth(s) whose
  // scope_catalog declares it.
  if (hasScopes) {
    for (const authKey of declaredAuths) {
      const catalog = manifest.auths?.[authKey]?.scope_catalog ?? [];
      const values = new Set(catalog.map((s) => s.value));
      if (agentScopes!.some((s) => values.has(s))) out.add(authKey);
    }
  }
  return out.size === 0 ? declaredAuths : [...out];
}

/**
 * Required oauth scopes for an agent's use of (integration, authKey): the
 * union of tool-inferred scopes ({@link scopesContributedByTools}) and the
 * agent's explicitly-selected scopes.
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
 * Union of `required_scopes` across the agent's selected tools, filtered by
 * `required_auth_key` so multi-auth integrations stay scoped to the current
 * auth. Returns `[]` when the agent picked zero tools.
 */
export function scopesContributedByTools(input: {
  manifest: IntegrationManifest;
  authKey: string;
  agentTools: readonly string[] | undefined;
}): string[] {
  if (!input.agentTools || input.agentTools.length === 0) return [];
  const toolsRecord = input.manifest.tools_policy;
  if (!toolsRecord) return [];

  const authKeys = input.manifest.auths ? Object.keys(input.manifest.auths) : [];
  const isSingleAuth = authKeys.length === 1;

  const out = new Set<string>();
  for (const toolName of input.agentTools) {
    const tool = toolsRecord[toolName];
    const requiredScopes = tool?.required_scopes as string[] | undefined;
    if (!tool || !requiredScopes || requiredScopes.length === 0) continue;
    if (isSingleAuth) {
      if (authKeys[0] !== input.authKey) continue;
    } else if (tool.required_auth_key !== input.authKey) continue;
    for (const s of requiredScopes) out.add(s);
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
  code: "unknown_tool" | "scope_not_in_catalog";
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

  if (selection.tools && selection.tools.length > 0) {
    const catalog = resolveIntegrationToolCatalog({
      integration: integrationManifest,
      mcpServerTools,
    });
    if (catalog.length > 0) {
      const allowed = new Set(catalog.map((e) => e.name));
      for (const tool of selection.tools) {
        if (allowed.has(tool)) continue;
        errors.push({
          field: `integrations.${selection.id}.tools`,
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
            field: `integrations.${selection.id}.scopes`,
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
  | "connection_blocked_by_admin"
  | "pinned_connection_unavailable"
  | "override_connection_unavailable"
  | "must_choose_connection"
  | "insufficient_scopes";

/** One unresolved integration plus structured detail. */
export interface ConnectionResolutionError {
  integrationId: string;
  code: ConnectionResolutionErrorCode;
  /** Candidate connection ids when `code === "must_choose_connection"`. */
  candidateConnectionIds?: string[];
  /** The under-scoped connection when `code === "insufficient_scopes"`. */
  connectionId?: string;
  /** Scopes the agent needs that the connection lacks (insufficient_scopes). */
  missingScopes?: string[];
  /** True when the resolved connection belongs to the current actor. */
  ownedByActor?: boolean;
  message: string;
}

/** Full resolver output. */
export interface ConnectionResolutionResult {
  resolved: ResolvedConnectionMap;
  errors: ConnectionResolutionError[];
}
