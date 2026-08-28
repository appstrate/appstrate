// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-run authorization grant — the ONLY thing that authorises an
 * ephemeral connect-run's sidecar on the platform's `/internal/*` surface.
 *
 * ## Why this exists
 *
 * Every `/internal/*` endpoint authorises through `verifyRunToken`, which
 * resolves the signed token's id to a `runs` row and then answers "what may
 * this run reach?" by walking the run's agent manifest. A connect run
 * (`runAt: "link"` orchestrated `connect.tool` login, see
 * `connect-run-launcher.ts`) has NEITHER: its id is minted as
 * `connect_<hex>` and never inserted into `runs`, and it has no agent at all —
 * it exists only to spawn one integration's mcp-server long enough to call its
 * `login` tool. Both walls are hard 404s, so the two calls its sidecar makes
 * on the way up could never succeed:
 *
 *   1. `GET /internal/integration-credentials/{integrationId}` —
 *      `runConnectOnce` awaits it BEFORE the spawn (it seeds the shared
 *      credentials Source) and throws on any non-2xx;
 *   2. `GET /internal/mcp-server-bundle/{mcpServerId}?version=` — the runnable
 *      bytes, fetched inside `spawnAndConnectLocalIntegration`.
 *
 * A grant is the narrow, short-lived replacement for the manifest walk: the
 * launcher resolves the spec (which integration, which mcp-server, which
 * concrete version) BEFORE it creates the sidecar, and writes exactly that
 * into the grant. The routes then authorise by EXACT MATCH against it. A
 * connect token therefore reaches one integration's (empty) credential
 * surface and one mcp-server's bytes at one version — nothing else in the org.
 *
 * ## Why the cache and not a table
 *
 * The grant's lifetime is the connect run's: written just before
 * `createSidecar`, deleted in the launcher's `finally`, with a TTL as the
 * crash backstop. Nothing reads it after the run and nothing may audit it
 * later — a `runs`-shaped row would outlive its own meaning and would need a
 * reaper. {@link getCache} is the same abstraction the credential-proxy
 * session binding and the idempotency store use, and its tier-0 adapter is
 * in-memory, so this works with no Redis.
 *
 * ## Fail-closed
 *
 * Absent grant, expired grant, unparseable payload, or a field of the wrong
 * shape all read as "no grant" — {@link readConnectRunGrant} returns null and
 * the caller refuses. There is no partial grant.
 */

import { getCache } from "../../infra/index.ts";

/**
 * Id prefix `connect-run-launcher.ts` mints connect-run ids with. It is the
 * discriminator the `/internal/*` routes branch on, and it is safe as one
 * because it is disjoint from every run id in the system: `runs.id` is only
 * ever minted as `run_${crypto.randomUUID()}` (routes/runs.ts, runs-remote.ts,
 * services/scheduler.ts — the complete set of INSERT sites). The token
 * signature covers the WHOLE id (`lib/run-token.ts`), so the platform only
 * ever validates ids it minted itself and a caller cannot re-label one
 * population as the other.
 */
export const CONNECT_ID_PREFIX = "connect_";

/** True when a verified token id belongs to the connect-run population. */
export function isConnectId(id: string): boolean {
  return id.startsWith(CONNECT_ID_PREFIX);
}

/**
 * What one connect run is allowed to reach. Every field here is READ BY A
 * CHECK — there is deliberately no field that is merely recorded, because a
 * value sitting in an authorization struct reads to the next person as a
 * boundary whether or not anything enforces it.
 *
 * That is why there is no `spaceId`: neither surface a connect run reaches is
 * space-scoped (the credentials answer is empty by construction, and package
 * bytes are org-scoped), so a space here would be decoration. If a
 * space-scoped surface is ever added, add the field WITH its comparison.
 */
export interface ConnectRunGrant {
  /**
   * Org the connect run acts in, taken from the caller's space scope.
   *
   * ENFORCED, not decoration: the byte route binds it as the tenant filter on
   * the `package_versions` lookup (`routes/internal.ts`,
   * `serveMcpServerBundle`), a query that carries no tenant boundary of its
   * own. That is a real comparison and not a vacuous one — this value is
   * frozen from the caller's scope at grant time, while the other side is the
   * org owning the row at FETCH time, so a package deleted and recreated in
   * another org between the two reads is refused. `orgOrSystemFilter`
   * semantics: the org's own packages OR system packages, matching the
   * org-scoped resolver that picked `mcpServerId` in the first place.
   */
  orgId: string;
  /** The ONE integration whose credential surface this run may read. */
  integrationId: string;
  /** The ONE mcp-server package whose bundle bytes this run may fetch. */
  mcpServerId: string;
  /**
   * The CONCRETE version the launcher's resolver picked, or `null` for a
   * system mcp-server (served from the in-memory boot registry by id alone —
   * the one population the byte route answers without a `?version=`). `null`
   * grants ONLY that short-circuit; it is never a licence to pick a version.
   */
  mcpServerVersion: string | null;
}

const KEY_PREFIX = "connect-run-grant:";

function cacheKey(connectId: string): string {
  return `${KEY_PREFIX}${connectId}`;
}

/**
 * Headroom on top of the connect-run timeout, covering the launch steps that
 * precede the timer (`createIsolationBoundary` + `createSidecar` + image pull)
 * and the teardown after it. The grant is deleted in the launcher's `finally`,
 * so the TTL only ever matters when the platform process dies mid-connect —
 * it bounds how long a leaked connect token stays useful after that crash.
 */
const GRANT_TTL_HEADROOM_SECONDS = 60;

/** TTL for a connect run whose sidecar is killed after `timeoutMs`. */
export function connectRunGrantTtlSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) + GRANT_TTL_HEADROOM_SECONDS;
}

/**
 * Publish the grant. Called by the launcher AFTER the spawn spec is resolved
 * and BEFORE the sidecar exists, so the sidecar's very first `/internal/*`
 * call already finds it.
 */
export async function writeConnectRunGrant(
  connectId: string,
  grant: ConnectRunGrant,
  ttlSeconds: number,
): Promise<void> {
  if (!isConnectId(connectId)) {
    // A grant keyed by anything but a connect id would be unreachable at best
    // and, if the id collided with a run id, an unauthorised second door into
    // the run surface. Never silently accept it.
    throw new Error(`connect-run grant: '${connectId}' is not a connect-run id`);
  }
  const cache = await getCache();
  await cache.set(cacheKey(connectId), JSON.stringify(grant), { ttlSeconds });
}

/**
 * Read the grant for a verified connect-run id. Returns `null` for every
 * "cannot authorise" state — absent, expired, unparseable, or carrying a field
 * of the wrong type — so callers have exactly one refusal branch.
 */
export async function readConnectRunGrant(connectId: string): Promise<ConnectRunGrant | null> {
  if (!isConnectId(connectId)) return null;
  const cache = await getCache();
  const raw = await cache.get(cacheKey(connectId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const g = parsed as Record<string, unknown>;
  if (
    typeof g.orgId !== "string" ||
    typeof g.integrationId !== "string" ||
    typeof g.mcpServerId !== "string" ||
    !(typeof g.mcpServerVersion === "string" || g.mcpServerVersion === null)
  ) {
    return null;
  }
  return {
    orgId: g.orgId,
    integrationId: g.integrationId,
    mcpServerId: g.mcpServerId,
    mcpServerVersion: g.mcpServerVersion,
  };
}

/** Revoke the grant. Idempotent — the launcher calls it from a `finally`. */
export async function deleteConnectRunGrant(connectId: string): Promise<void> {
  const cache = await getCache();
  await cache.del(cacheKey(connectId));
}
