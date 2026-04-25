// SPDX-License-Identifier: Apache-2.0

/**
 * Thin factory around {@link SidecarProviderResolver} for Appstrate's
 * container orchestrator. The orchestrator spawns a sidecar colocated
 * with the agent container on a private Docker network; this helper
 * builds a `ProviderResolver` pointing at it so the AFPS 1.3 runner
 * (once Appstrate migrates to `@appstrate/afps-runtime`'s `Runner`) can
 * resolve `dependencies.providers[]` into Tools without duplicating
 * transport logic.
 *
 * The sidecar HTTP contract (X-Provider / X-Target / cookie jar /
 * credential injection via the platform `/internal/credentials/…`
 * endpoints) is unchanged — this is wire-compatible with the existing
 * `runtime-pi/sidecar/server.ts`.
 *
 * The legacy `curl $SIDECAR_URL/proxy` code-path documented in the
 * prompt also remains supported; agents migrating to AFPS 1.3 can use
 * the typed Tool surface produced by this resolver instead.
 */

import {
  SidecarProviderResolver,
  type SidecarProviderResolverOptions,
} from "@appstrate/afps-runtime/resolvers";

/** Options accepted by {@link createSidecarProviderResolver}. */
export interface CreateSidecarProviderResolverOptions extends Omit<
  SidecarProviderResolverOptions,
  "sidecarUrl"
> {
  /**
   * Address of the sidecar proxy inside the agent container network.
   * Typically provided to the agent container as the `SIDECAR_URL`
   * environment variable.
   */
  sidecarUrl: string;
}

/**
 * Build a ProviderResolver bound to a specific run's sidecar. Safe to
 * call per-run — no caching; creates a fresh resolver every time.
 */
export function createSidecarProviderResolver(
  opts: CreateSidecarProviderResolverOptions,
): SidecarProviderResolver {
  return new SidecarProviderResolver(opts);
}
