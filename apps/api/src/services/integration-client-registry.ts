// SPDX-License-Identifier: Apache-2.0

/**
 * System-level integration OAuth clients (env-sourced).
 *
 * The platform can provide a shared OAuth client (client_id/secret) for an
 * integration `auths.{key}` via the `SYSTEM_INTEGRATION_CLIENTS` env var. This
 * is the standard SaaS connector pattern: one vendor-registered, verified app
 * (e.g. the Appstrate Google app) used by every organization, so users connect
 * out of the box without registering their own Google Cloud project.
 *
 * Tenant isolation lives at the token layer (per-connection encrypted tokens),
 * not at the client_id — the shared client only identifies the app to the IdP.
 *
 * An org that registers its OWN per-application client (`integration_oauth_clients`,
 * "BYO-app") overrides the system client at connect time. Whichever client mints
 * a connection is pinned on the row via `client_ref` so token refresh resolves
 * the same credentials.
 *
 * Mirrors the model-provider system-key pattern (`model-registry.ts` +
 * `SYSTEM_PROVIDER_KEYS`): parse env JSON → validate with Zod → populate a
 * module-static Map at boot → expose read-only accessors.
 */

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { loadSystemRegistry } from "../lib/system-registry.ts";

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

const rawSystemIntegrationClientSchema = z.object({
  // Constrained to the same charset the wire `client_ref` accepts (`^[\w.-]+$`)
  // so every configured client is explicitly selectable at connect time — the
  // registry-admissible id set == the API-addressable set. MUST NOT be
  // UUID-shaped: ids are resolved system-first, so a system id colliding with a
  // custom `integration_oauth_clients.id` (UUID) would shadow the custom row.
  id: z.string().regex(/^[\w.-]+$/, "id must match ^[\\w.-]+$"),
  integrationId: z.string().min(1),
  authKey: z
    .string()
    // AFPS §7.2: auth keys match `^[a-z][a-z0-9_]*$` — mirror the manifest gate.
    .regex(/^[a-z][a-z0-9_]*$/, "authKey must match ^[a-z][a-z0-9_]*$"),
  clientId: z.string().min(1),
  // Public clients (`token_endpoint_auth_method: "none"`) carry an empty secret.
  clientSecret: z.string().default(""),
});

type RawSystemIntegrationClient = z.infer<typeof rawSystemIntegrationClientSchema>;

let systemIntegrationClients: Map<string, SystemIntegrationClientDefinition> | null = null;

/** Composite key for the `(integrationId, authKey)` index — JSON-encoded so the
 * two parts can never collide regardless of their contents (no in-band separator). */
function authIndexKey(integrationId: string, authKey: string): string {
  return JSON.stringify([integrationId, authKey]);
}

/**
 * Parse + validate `SYSTEM_INTEGRATION_CLIENTS` and populate the module-static
 * registry. Invalid entries are skipped with a logged error (one bad entry
 * never blocks the rest), exactly like `initSystemModelProviderKeys`. Call once
 * at boot, before any connect/refresh path runs.
 */
export function initSystemIntegrationClients(rawOverride?: unknown[]): void {
  systemIntegrationClients = loadSystemRegistry<
    RawSystemIntegrationClient,
    SystemIntegrationClientDefinition
  >({
    name: "integration-client-registry",
    envVar: "SYSTEM_INTEGRATION_CLIENTS",
    // Production reads the parsed env; tests inject a raw array directly (the
    // env is cached at first access, so an override seam is cleaner than
    // mutating process.env after boot).
    entries: rawOverride ?? (getEnv().SYSTEM_INTEGRATION_CLIENTS as unknown[]),
    schema: rawSystemIntegrationClientSchema,
    // Validated shape is exactly SystemIntegrationClientDefinition.
    toDefinition: (def) => def,
    // Never log the secret.
    redact: (entry) => ({ ...(entry as Record<string, unknown>), clientSecret: undefined }),
  });
}

function ensureInitialized(): ReadonlyMap<string, SystemIntegrationClientDefinition> {
  // Fail-fast on access-before-init — mirrors the sibling system registries
  // (`model-registry.ts`, `proxy-registry.ts`), which throw rather than lazily
  // self-initialize. Boot calls initSystemIntegrationClients() eagerly before any
  // connect/refresh path runs; a null here means that boot step was skipped (a
  // wiring bug), surfaced loudly instead of silently behaving as "no system
  // clients". The test seam resets to an empty (initialized) registry, so this
  // guard never fires in tests.
  if (!systemIntegrationClients) {
    throw new Error(
      "[integration-client-registry] System integration clients not initialized. Call initSystemIntegrationClients() at boot.",
    );
  }
  return systemIntegrationClients;
}

/** All system integration clients, keyed by id. */
export function getSystemIntegrationClients(): ReadonlyMap<
  string,
  SystemIntegrationClientDefinition
> {
  return ensureInitialized();
}

/** Resolve a system client by its id, or `null` when unknown. */
export function getSystemIntegrationClientById(
  id: string,
): SystemIntegrationClientDefinition | null {
  return ensureInitialized().get(id) ?? null;
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
  for (const def of ensureInitialized().values()) {
    if (authIndexKey(def.integrationId, def.authKey) === wanted) out.push(def);
  }
  return out;
}

/**
 * `true` when the platform ships a system OAuth client for ANY auth of this
 * integration (any `SYSTEM_INTEGRATION_CLIENTS` entry whose `integrationId`
 * matches). This is the "auto-active" predicate: a system integration is on by
 * default — usable out of the box — until an org explicitly opts out. Evaluated
 * per package id, not per auth key, because activation lives on
 * `application_packages` (per package); the one-click connect still resolves
 * per auth via {@link listSystemIntegrationClientsFor}. Boot-loaded, so present
 * without any prior user action (unlike DCR `auto_provisioned` clients, which
 * only exist after a first connect).
 */
export function hasSystemIntegrationClient(integrationId: string): boolean {
  for (const def of ensureInitialized().values()) {
    if (def.integrationId === integrationId) return true;
  }
  return false;
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
 * operator reshuffling `SYSTEM_INTEGRATION_CLIENTS` must never let one
 * integration's connection resolve another's credentials.
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
 * `ensureInitialized`. Seed by calling `initSystemIntegrationClients([...])`.
 */
export function __resetSystemIntegrationClientsForTest(): void {
  systemIntegrationClients = new Map();
}
