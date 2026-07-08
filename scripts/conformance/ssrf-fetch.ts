// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF-guarded fetch for outbound discovery / `tools/list` calls. Refuses
 * loopback / RFC1918 / link-local / metadata targets so a manifest's
 * `source.remote.url` can never point the harness at internal infra. Parity
 * with the connect engine's per-request guard.
 *
 * Typed via `Parameters<typeof fetch>` and cast `as typeof fetch` so it
 * satisfies the MCP SDK transport's `fetch` option (which expects the full
 * `fetch` shape, including `preconnect`).
 */

import { guardedFetch } from "@appstrate/core/ssrf";

export const ssrfGuardedFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  // Delegate to the shared per-hop DNS-guarded fetch. Unlike the old literal-only
  // `isBlockedUrl` screen (initial URL only, no DNS), `guardedFetch` resolves +
  // blocklist-checks the initial host AND every redirect target (manual
  // redirects), closing both the DNS-rebind and the redirect-to-internal bypass.
  const url = typeof input === "string" || input instanceof URL ? input : input.url;
  return guardedFetch(url, init);
}) as typeof fetch;
