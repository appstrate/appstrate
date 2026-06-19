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
import { logger } from "../lib/logger.ts";

// `integration_connections.client_ref` is a flat client id — the env id of a
// system client or the `integration_oauth_clients.id` (UUID) of a custom client.
// No prefix/sentinel scheme: resolution is system-first then DB-by-id, mirroring
// the model-provider credential pattern (`loadInferenceCredentials`).

export interface SystemIntegrationClientDefinition {
  /** Stable id — the connection's `client_ref` when this client mints it. */
  id: string;
  /** Integration package id this client serves (e.g. `@appstrate/integration-gmail`). */
  integrationId: string;
  /** Auth key within the integration manifest (`manifest.auths.{key}`). */
  authKey: string;
  /** OAuth2 client id registered with the upstream IdP. */
  clientId: string;
  /** OAuth2 client secret. Empty string for public clients. */
  clientSecret: string;
}

// Per-client entry, nested under an integration. Wire keys are snake_case
// (env JSON, per CASING_CONVENTIONS); mapped to camelCase internally.
const rawSystemIntegrationClientSchema = z.object({
  // Constrained to the same charset the wire `client_ref` accepts (`^[\w.-]+$`)
  // so every configured client is explicitly selectable at connect time — the
  // registry-admissible id set == the API-addressable set. MUST NOT be
  // UUID-shaped: ids are resolved system-first, so a system id colliding with a
  // custom `integration_oauth_clients.id` (UUID) would shadow the custom row.
  id: z.string().regex(/^[\w.-]+$/, "id must match ^[\\w.-]+$"),
  // AFPS §7.2: auth keys match `^[a-z][a-z0-9_]*$` — mirror the manifest gate.
  auth_key: z.string().regex(/^[a-z][a-z0-9_]*$/, "auth_key must match ^[a-z][a-z0-9_]*$"),
  client_id: z.string().min(1),
  // Public clients (`token_endpoint_auth_method: "none"`) carry an empty secret.
  client_secret: z.string().default(""),
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
 * registry. Invalid entries (and invalid nested clients) are skipped with a
 * logged error — one bad entry never blocks the rest, exactly like
 * `initSystemModelProviderKeys`. Call once at boot, before any connect/refresh
 * path runs.
 */
export function initSystemIntegrations(rawOverride?: unknown[]): void {
  // Production reads the parsed env; tests inject a raw array directly (the env
  // is cached at first access, so an override seam is cleaner than mutating
  // process.env after boot).
  const entries = rawOverride ?? (getEnv().SYSTEM_INTEGRATIONS as unknown[]);

  const ids = new Set<string>();
  const clients = new Map<string, SystemIntegrationClientDefinition>();

  for (const entry of entries) {
    const parsed = rawSystemIntegrationSchema.safeParse(entry);
    if (!parsed.success) {
      logger.error("[integration-client-registry] SYSTEM_INTEGRATIONS: skipping invalid entry", {
        error: parsed.error.issues[0]?.message,
        // Drop nested client secrets before logging.
        entry: redactEntry(entry),
      });
      continue;
    }
    const { id, clients: rawClients } = parsed.data;
    if (ids.has(id)) {
      logger.error(
        "[integration-client-registry] SYSTEM_INTEGRATIONS: skipping duplicate integration id",
        { id },
      );
      continue;
    }
    ids.add(id);

    for (const c of rawClients) {
      if (clients.has(c.id)) {
        // Client ids are the `client_ref` keyspace and resolved globally
        // (system-first by id) — they must be unique across ALL integrations,
        // not just within one entry.
        logger.error(
          "[integration-client-registry] SYSTEM_INTEGRATIONS: skipping duplicate client id",
          { id: c.id, integrationId: id },
        );
        continue;
      }
      clients.set(c.id, {
        id: c.id,
        integrationId: id,
        authKey: c.auth_key,
        clientId: c.client_id,
        clientSecret: c.client_secret,
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
 * Redact nested client credentials from a raw entry before logging. Drops BOTH
 * `client_secret` and `client_id`: the system client_id is a deployment secret
 * (never returned to the front — only an opaque fingerprint is, see
 * `fingerprintSystemClientId` in integration-connections.ts), so it must not
 * land in logs either.
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

/** All system integration clients, keyed by id. */
export function getSystemIntegrationClients(): ReadonlyMap<
  string,
  SystemIntegrationClientDefinition
> {
  return ensureInitialized().clients;
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
