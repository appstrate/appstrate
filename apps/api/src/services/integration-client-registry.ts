// SPDX-License-Identifier: Apache-2.0

/**
 * System-level integrations (env-sourced).
 *
 * The deployment declares which integrations it OFFERS out of the box via the
 * `SYSTEM_INTEGRATIONS` env var. Membership in that list is the "auto-active"
 * policy signal: a system integration is on by default — usable without any
 * prior user action — until an org explicitly opts out (a sticky
 * `application_packages.enabled = false`).
 *
 * Membership is decoupled from credentials. An entry MAY ship one or more
 * shared OAuth clients (client_id/secret) for its `auths.{key}` — the standard
 * SaaS connector pattern: one vendor-registered, verified app (e.g. the
 * Appstrate Google app) used by every organization, so users connect out of the
 * box without registering their own OAuth project. An entry MAY also ship NO
 * clients: remote MCP integrations that rely on Dynamic Client Registration
 * (RFC 7591) have no static client_id — they are still offered by default
 * (auto-active) and provision their client lazily on first connect.
 *
 *   SYSTEM_INTEGRATIONS = [
 *     // shared OAuth client (e.g. Gmail):
 *     { "id": "@appstrate/gmail",
 *       "clients": [{ "id": "gmail-sys", "auth_key": "google",
 *                     "client_id": "…", "client_secret": "…" }] },
 *     // shared PUBLIC client — DECLARED, never inferred from a missing secret:
 *     { "id": "@appstrate/dropbox",
 *       "clients": [{ "id": "dropbox-sys", "auth_key": "dropbox",
 *                     "client_id": "…", "token_endpoint_auth_method": "none" }] },
 *     // DCR remote MCP — offered by default, no static client:
 *     { "id": "@appstrate/foo-mcp" }
 *   ]
 *
 * Tenant isolation lives at the token layer (per-connection encrypted tokens),
 * not at the client_id — a shared client only identifies the app to the IdP.
 *
 * An org that registers its OWN per-application client (`integration_oauth_clients`,
 * "BYO-app") overrides the system client at connect time. Whichever client mints
 * a connection is pinned on the row via `client_ref` so token refresh resolves
 * the same credentials.
 *
 * Mirrors the model-provider system-key pattern (`model-registry.ts` +
 * `SYSTEM_PROVIDER_KEYS`): parse env JSON → validate with Zod → populate
 * module-static state at boot → expose read-only accessors.
 */

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { CREDENTIAL_KEY_RE } from "@appstrate/core/naming";
import type { TokenEndpointAuthMethod } from "@appstrate/connect";
import { logger } from "../lib/logger.ts";
import { formatZodIssues } from "../lib/zod-format.ts";
import {
  CLIENT_SECRET_REQUIRED_MESSAGE,
  PUBLIC_CLIENT_WITH_SECRET_MESSAGE,
} from "./integration-manifest-helpers.ts";

// `integration_connections.client_ref` is a flat client id — the env id of a
// system client or the `integration_oauth_clients.id` (UUID) of a custom client.
// No prefix/sentinel scheme: resolution is system-first then DB-by-id, mirroring
// the model-provider credential pattern (`loadInferenceCredentials`).

/**
 * The RFC 7591 §2 methods a system entry may declare — the same set the API's
 * per-application client body accepts (`oauthClientSchema`,
 * `routes/integrations.ts`), so the env-sourced and DB-sourced halves of the
 * same credential surface stay declarable in exactly the same terms.
 *
 * A tuple because `z.enum` needs one, `satisfies` because the union itself is
 * NOT declared here: `TokenEndpointAuthMethod` (`@appstrate/connect`) is the
 * single source of truth, and this literal is checked against it rather than
 * re-spelling it. Adding a method there and forgetting it here is now a
 * deliberate narrowing rather than a silent divergence; spelling one WRONG here
 * fails to compile.
 */
const SYSTEM_CLIENT_AUTH_METHODS = [
  "client_secret_post",
  "client_secret_basic",
  "none",
] as const satisfies readonly TokenEndpointAuthMethod[];

export interface SystemIntegrationClientDefinition {
  /** Stable id — the connection's `client_ref` when this client mints it. */
  id: string;
  /** Integration package id this client serves (e.g. `@appstrate/integration-gmail`). */
  integrationId: string;
  /** Auth key within the integration manifest (`manifest.auths.{key}`). */
  authKey: string;
  /** OAuth2 client id registered with the upstream IdP. */
  clientId: string;
  /**
   * OAuth2 client secret, or `undefined` when the entry declared itself PUBLIC
   * (`token_endpoint_auth_method: "none"`). Never the empty string: the schema
   * refuses a blank secret, so "no secret here" cannot be confused with "the
   * operator left the field out".
   */
  clientSecret: string | undefined;
  /**
   * Client-authentication method this entry DECLARES, or `undefined` when it
   * declares none and the manifest's `auths.{key}.token_endpoint_auth_method`
   * applies. Read directly by every consumer — nothing derives it from the
   * secret's presence, which is the inference that put `client_secret=`
   * (present but empty) on the wire.
   */
  tokenEndpointAuthMethod: TokenEndpointAuthMethod | undefined;
}

// Per-client entry, nested under an integration. Wire keys are snake_case
// (env JSON, per CASING_CONVENTIONS); mapped to camelCase internally.
const rawSystemIntegrationClientSchema = z
  .object({
    // Constrained to the same charset the wire `client_ref` accepts (`^[\w.-]+$`)
    // so every configured client is explicitly selectable at connect time — the
    // registry-admissible id set == the API-addressable set. MUST NOT be
    // UUID-shaped: ids are resolved system-first, so a system id colliding with a
    // custom `integration_oauth_clients.id` (UUID) would shadow the custom row.
    id: z.string().regex(/^[\w.-]+$/, "id must match ^[\\w.-]+$"),
    // AFPS §7.2: auth keys match `^[a-z][a-z0-9_]*$` — mirror the manifest gate
    // via the canonical `CREDENTIAL_KEY_RE` (@appstrate/core/naming).
    auth_key: z.string().regex(CREDENTIAL_KEY_RE, "auth_key must match ^[a-z][a-z0-9_]*$"),
    client_id: z.string().min(1),
    /**
     * OPTIONAL and never defaulted. `z.string().default("")` used to live here,
     * and it is exactly the inference the per-application client body deleted
     * (`oauthClientSchema`, `routes/integrations.ts`): a blank secret cannot tell
     * "declared public" from "operator forgot the secret", so an entry missing
     * its `client_secret` became a silently PUBLIC client whose token request the
     * provider answers with `invalid_client`. The `.refine` below makes the
     * declaration mandatory instead.
     */
    client_secret: z.string().min(1).optional(),
    /**
     * The entry's explicit declaration, overriding the manifest's for this
     * client. `"none"` registers a PUBLIC client — the app has no secret at the
     * provider and authenticates by `client_id` alone.
     */
    token_endpoint_auth_method: z.enum(SYSTEM_CLIENT_AUTH_METHODS).optional(),
  })
  // Both directions of the pair, mirroring `oauthClientCreateSchema`'s two
  // refines exactly — an operator must be able to declare the same client the
  // same way whether it arrives by env or by API. The two rejection messages are
  // IMPORTED rather than restated, so "exactly" is a fact the compiler keeps
  // rather than a claim this comment makes.
  //
  // No secret AND no `"none"` (including "no method at all", which means "the
  // manifest's method applies"): the token request cannot succeed. Boot crash
  // beats the alternative, which is the provider answering `invalid_client`
  // months later on a flow nobody changed.
  .refine((c) => c.client_secret !== undefined || c.token_endpoint_auth_method === "none", {
    message: CLIENT_SECRET_REQUIRED_MESSAGE,
    path: ["client_secret"],
  })
  // `"none"` WITH a secret: the operator resolved a credential and then said it
  // would not be used. One of the two is a mistake and the registry cannot tell
  // which, so it refuses rather than silently discarding a real secret.
  .refine((c) => !(c.token_endpoint_auth_method === "none" && c.client_secret !== undefined), {
    message: PUBLIC_CLIENT_WITH_SECRET_MESSAGE,
    path: ["client_secret"],
  });

// One offered integration. `clients` optional/empty → DCR remote MCP (offered
// by default, no static client). Entry `id` is a package id (`@scope/name`),
// not the `^[\w.-]+$` client-ref charset.
const rawSystemIntegrationSchema = z.object({
  id: z.string().min(1),
  clients: rawSystemIntegrationClientSchema.array().default([]),
});

// Set of integration package ids offered by default (the auto-active policy).
let systemIntegrationIds: Set<string> | null = null;
// Flattened clients keyed by client id (the credential surface).
let systemIntegrationClients: Map<string, SystemIntegrationClientDefinition> | null = null;

/** Composite key for the `(integrationId, authKey)` index — JSON-encoded so the
 * two parts can never collide regardless of their contents (no in-band separator). */
function authIndexKey(integrationId: string, authKey: string): string {
  return JSON.stringify([integrationId, authKey]);
}

/**
 * Parse + validate `SYSTEM_INTEGRATIONS` and populate the module-static
 * registry. Every declared entry MUST be valid and uniquely identified: an
 * invalid entry, a duplicate integration id or a duplicate client id THROWS and
 * aborts boot (same rule as `initSystemModelProviderKeys`' strict branch — see
 * the rationale on each throw). Call once at boot, before any connect/refresh
 * path runs.
 */
export function initSystemIntegrations(rawOverride?: unknown[]): void {
  // Production reads the parsed env; tests inject a raw array directly (the env
  // is cached at first access, so an override seam is cleaner than mutating
  // process.env after boot).
  const entries = rawOverride ?? (getEnv().SYSTEM_INTEGRATIONS as unknown[]);

  const ids = new Set<string>();
  const clients = new Map<string, SystemIntegrationClientDefinition>();

  // Indexed so an error can point at a position in the env array: the entry id
  // is itself what may be missing or malformed, so it cannot be the only handle.
  for (const [index, entry] of entries.entries()) {
    const parsed = rawSystemIntegrationSchema.safeParse(entry);
    if (!parsed.success) {
      // ENFORCED INVARIANT: every declared SYSTEM_INTEGRATIONS entry is valid.
      // Declared-but-invalid = boot crash (throw, not skip): silently dropping
      // the entry would leave the operator believing the integration is offered
      // while every downstream failure blames application state instead of the
      // env var — a dropped membership surfaces as "Integration 'X' is not
      // installed in this application", a dropped client as "Administrator must
      // register OAuth client credentials for …". The entry schema embeds
      // `clients` and validates atomically, so ONE mistyped nested client takes
      // its integration's membership down with it: `describeIssues` names the
      // exact failing path (and client) rather than just "this entry".
      throw new Error(
        `[integration-client-registry] SYSTEM_INTEGRATIONS entry #${index}${describeEntryId(entry)} ` +
          `is invalid: ${describeIssues(entry, parsed.error)}. Fix or remove it — a declared ` +
          `integration that was silently dropped fails later at connect time with an unrelated error ` +
          `blaming application state. Entry (secrets redacted): ${JSON.stringify(redactEntry(entry))}`,
      );
    }
    const { id, clients: rawClients } = parsed.data;
    if (ids.has(id)) {
      // Same reasoning: keeping the first and dropping the rest would strip the
      // later entry's clients while the operator reads both in the env var.
      throw new Error(
        `[integration-client-registry] SYSTEM_INTEGRATIONS entry #${index} re-declares integration id ` +
          `"${id}", already declared by an earlier entry. Merge their clients into a single entry — ` +
          `dropping the duplicate would silently discard everything the later one configures.`,
      );
    }
    ids.add(id);

    for (const c of rawClients) {
      if (clients.has(c.id)) {
        // Client ids are the `client_ref` keyspace and resolved globally
        // (system-first by id) — they must be unique across ALL integrations,
        // not just within one entry. A collision has no safe resolution: the
        // loser's connections would pin a `client_ref` that resolves to another
        // integration's credentials (`resolveSystemClientForAuth` then returns
        // null and the connect path reports a missing OAuth client). Refuse to
        // boot instead of picking a winner behind the operator's back.
        throw new Error(
          `[integration-client-registry] SYSTEM_INTEGRATIONS entry #${index} ("${id}") declares client id ` +
            `"${c.id}", already registered by integration "${clients.get(c.id)!.integrationId}". Client ids ` +
            `form one global keyspace (the connection's client_ref) — rename one of them.`,
        );
      }
      clients.set(c.id, {
        id: c.id,
        integrationId: id,
        authKey: c.auth_key,
        clientId: c.client_id,
        clientSecret: c.client_secret,
        tokenEndpointAuthMethod: c.token_endpoint_auth_method,
      });
    }
  }

  systemIntegrationIds = ids;
  systemIntegrationClients = clients;
  logger.info("[integration-client-registry] loaded", {
    integrations: ids.size,
    clients: clients.size,
  });
}

/**
 * Redact nested client credentials from a raw entry before it is logged or
 * embedded in a boot error message. Drops BOTH
 * `client_secret` and `client_id`: the system client_id is a deployment secret
 * (never returned to the front — only an opaque fingerprint is, see
 * `fingerprintSystemClientId` in integration-connections.ts), so it must not
 * land in logs — or in a crash stack trace — either.
 */
function redactEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const clients = Array.isArray(e.clients)
    ? e.clients.map((c) =>
        c && typeof c === "object"
          ? { ...(c as Record<string, unknown>), client_id: undefined, client_secret: undefined }
          : c,
      )
    : e.clients;
  return { ...e, clients };
}

/**
 * ` ("@scope/name")` when the raw entry carries a usable string id, `""`
 * otherwise. The entry id is the operator's own handle on the entry, so quote
 * it whenever it survived far enough to be readable — the array index alone
 * makes them count braces in a one-line env var.
 */
function describeEntryId(entry: unknown): string {
  const id = (entry as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? ` ("${id}")` : "";
}

/**
 * The ids of the nested clients an issue set points at, in path order, deduped.
 * The entry schema validates the embedded client array atomically, so one bad
 * client rejects the whole entry — this names WHICH client. The id is not a
 * secret (unlike client_id/client_secret, which `redactEntry` drops).
 */
function namedClientIds(entry: unknown, issues: readonly z.core.$ZodIssue[]): string[] {
  const rawClients = (entry as { clients?: unknown } | null | undefined)?.clients;
  if (!Array.isArray(rawClients)) return [];
  const out: string[] = [];
  for (const issue of issues) {
    const [head, idx] = issue.path;
    if (head !== "clients" || typeof idx !== "number") continue;
    const id = (rawClients[idx] as { id?: unknown } | null | undefined)?.id;
    if (typeof id === "string" && id.length > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Render a rejected entry via `formatZodIssues`, annotated with the offending client ids. */
function describeIssues(entry: unknown, error: z.ZodError): string {
  const detail = formatZodIssues(error);
  const clients = namedClientIds(entry, error.issues);
  if (clients.length === 0) return detail;
  const label = clients.length === 1 ? "client" : "clients";
  return `${detail} (${label} ${clients.map((id) => `"${id}"`).join(", ")})`;
}

function ensureInitialized(): {
  ids: ReadonlySet<string>;
  clients: ReadonlyMap<string, SystemIntegrationClientDefinition>;
} {
  // Fail-fast on access-before-init — mirrors the sibling system registries
  // (`model-registry.ts`, `proxy-registry.ts`), which throw rather than lazily
  // self-initialize. Boot calls initSystemIntegrations() eagerly before any
  // connect/refresh path runs; a null here means that boot step was skipped (a
  // wiring bug), surfaced loudly instead of silently behaving as "no system
  // integrations". The test seam resets to an empty (initialized) registry, so
  // this guard never fires in tests.
  if (!systemIntegrationIds || !systemIntegrationClients) {
    throw new Error(
      "[integration-client-registry] System integrations not initialized. Call initSystemIntegrations() at boot.",
    );
  }
  return { ids: systemIntegrationIds, clients: systemIntegrationClients };
}

/**
 * `true` when the integration is OFFERED by the deployment — listed in
 * `SYSTEM_INTEGRATIONS`, regardless of whether it ships a shared OAuth client.
 * This is the "auto-active" predicate: a system integration is on by default —
 * usable out of the box — until an org explicitly opts out. Evaluated per
 * package id, not per auth key, because activation lives on
 * `application_packages` (per package). Boot-loaded, so present without any
 * prior user action (unlike DCR `auto_provisioned` clients, which only exist
 * after a first connect). DCR remote MCP integrations are offered with NO
 * client and still return `true` here.
 */
export function isSystemIntegration(integrationId: string): boolean {
  return ensureInitialized().ids.has(integrationId);
}

/** Resolve a system client by its id, or `null` when unknown. */
export function getSystemIntegrationClientById(
  id: string,
): SystemIntegrationClientDefinition | null {
  return ensureInitialized().clients.get(id) ?? null;
}

/**
 * System clients registered for a given `(integrationId, authKey)`. Multiple
 * may exist (rare); the connect default picks the first. Returned in stable
 * insertion order (env order).
 */
export function listSystemIntegrationClientsFor(
  integrationId: string,
  authKey: string,
): SystemIntegrationClientDefinition[] {
  const wanted = authIndexKey(integrationId, authKey);
  const out: SystemIntegrationClientDefinition[] = [];
  for (const def of ensureInitialized().clients.values()) {
    if (authIndexKey(def.integrationId, def.authKey) === wanted) out.push(def);
  }
  return out;
}

/**
 * The default system client for `(integrationId, authKey)` — the first
 * registered — or `null` when none. Used as the connect fallback when an org
 * has not registered its own client.
 */
export function getDefaultSystemIntegrationClient(
  integrationId: string,
  authKey: string,
): SystemIntegrationClientDefinition | null {
  return listSystemIntegrationClientsFor(integrationId, authKey)[0] ?? null;
}

/**
 * Resolve a system client by id AND re-validate it still serves this exact
 * `(integrationId, authKey)`. Single source of truth for that security-critical
 * guard — shared by the connect resolver (`resolveConnectClient`) and the
 * refresh resolver (`resolveIntegrationClientById`). Returns `null`
 * when the id is unknown OR was remapped to a different integration/auth: an
 * operator reshuffling `SYSTEM_INTEGRATIONS` must never let one integration's
 * connection resolve another's credentials.
 */
export function resolveSystemClientForAuth(
  id: string,
  integrationId: string,
  authKey: string,
): SystemIntegrationClientDefinition | null {
  const def = getSystemIntegrationClientById(id);
  if (!def || def.integrationId !== integrationId || def.authKey !== authKey) return null;
  return def;
}

/**
 * Test-only reset hook. Resets to an empty *initialized* registry (not null) so
 * tests that touch the accessors after a reset without re-seeding observe an
 * empty set rather than tripping the access-before-init guard in
 * `ensureInitialized`. Seed by calling `initSystemIntegrations([...])`.
 */
export function __resetSystemIntegrationsForTest(): void {
  systemIntegrationIds = new Set();
  systemIntegrationClients = new Map();
}
