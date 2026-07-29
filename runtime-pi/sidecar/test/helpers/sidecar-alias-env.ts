// SPDX-License-Identifier: Apache-2.0

/**
 * Scope `SIDECAR_DNS_ALIAS` around a single request.
 *
 * The sidecar's Host guard (`isAllowedSidecarHostname`, `mcp.ts`) reads
 * `process.env` per call rather than capturing it at import time, because the
 * alias is minted per run. Tests therefore only need the variable set for the
 * duration of one `app.request()`.
 */

/**
 * Run `fn` with `SIDECAR_DNS_ALIAS` set to `alias` (or unset when
 * `undefined`), restoring the previous value afterwards so the surrounding
 * suite stays order-independent. `fn` returns `T | PromiseLike<T>` because
 * Hono's `app.request()` is typed `Response | Promise<Response>`.
 */
export async function withAlias<T>(
  alias: string | undefined,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  const previous = process.env.SIDECAR_DNS_ALIAS;
  if (alias === undefined) delete process.env.SIDECAR_DNS_ALIAS;
  else process.env.SIDECAR_DNS_ALIAS = alias;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SIDECAR_DNS_ALIAS;
    else process.env.SIDECAR_DNS_ALIAS = previous;
  }
}
