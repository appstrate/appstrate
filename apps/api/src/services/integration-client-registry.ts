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
import { logger } from "../lib/logger.ts";

/** `client_ref` value pinning a connection to a system client by id. */
export const SYSTEM_CLIENT_REF_PREFIX = "system:";
/**
 * `client_ref` value pinning a connection to the org's own per-application
 * `integration_oauth_clients` row. Unqualified because at most one custom row
 * exists per `(applicationId, integrationId, authKey)` — it is resolved by that
 * tuple, never by an opaque id.
 */
export const CUSTOM_CLIENT_REF = "custom";

/** Build the `client_ref` for a system client id. */
export function systemClientRef(id: string): string {
  return `${SYSTEM_CLIENT_REF_PREFIX}${id}`;
}

/**
 * Parse a canonical `client_ref` into its discriminated kind. `client_ref` is a
 * closed set: `"system:<id>"` or `"custom"`. It is always server-derived (the
 * connect resolver canonicalizes it; the connect-body value is Zod-validated to
 * the same shape), so a value outside the set is corruption — we throw rather
 * than silently coerce.
 */
export function parseClientRef(ref: string): { kind: "system"; id: string } | { kind: "custom" } {
  if (ref.startsWith(SYSTEM_CLIENT_REF_PREFIX)) {
    return { kind: "system", id: ref.slice(SYSTEM_CLIENT_REF_PREFIX.length) };
  }
  if (ref === CUSTOM_CLIENT_REF) return { kind: "custom" };
  throw new Error(`Invalid client_ref: ${JSON.stringify(ref)}`);
}

export interface SystemIntegrationClientDefinition {
  /** Stable id — referenced by `client_ref = "system:<id>"`. */
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
  // Constrained to the same charset the wire `client_ref` regex addresses
  // (`system:[\w.-]+`) so every configured client is also explicitly selectable
  // at connect time — the registry-admissible id set == the API-addressable set.
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
  const byId = new Map<string, SystemIntegrationClientDefinition>();
  // Production reads the parsed env; tests inject a raw array directly (the
  // env is cached at first access, so an override seam is cleaner than mutating
  // process.env after boot).
  const raw = (rawOverride ??
    (getEnv().SYSTEM_INTEGRATION_CLIENTS as unknown[])) as RawSystemIntegrationClient[];

  for (const entry of raw) {
    const parsed = rawSystemIntegrationClientSchema.safeParse(entry);
    if (!parsed.success) {
      logger.error(
        "[integration-client-registry] SYSTEM_INTEGRATION_CLIENTS: skipping invalid entry",
        {
          error: parsed.error.issues[0]?.message,
          // Never log the secret.
          entry: { ...(entry as Record<string, unknown>), clientSecret: undefined },
        },
      );
      continue;
    }
    const def = parsed.data;
    if (byId.has(def.id)) {
      logger.error(
        "[integration-client-registry] SYSTEM_INTEGRATION_CLIENTS: skipping duplicate id",
        {
          id: def.id,
        },
      );
      continue;
    }
    byId.set(def.id, {
      id: def.id,
      integrationId: def.integrationId,
      authKey: def.authKey,
      clientId: def.clientId,
      clientSecret: def.clientSecret,
    });
  }

  systemIntegrationClients = byId;
  logger.info("[integration-client-registry] system integration clients loaded", {
    count: byId.size,
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
 * guard — shared by the connect resolver (`resolveSystemConnectClient`) and the
 * token-refresh path (`buildIntegrationOAuthRefreshContext`). Returns `null`
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
