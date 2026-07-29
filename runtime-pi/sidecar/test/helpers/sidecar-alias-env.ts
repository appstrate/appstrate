// SPDX-License-Identifier: Apache-2.0

/**
 * Run `fn` with `SIDECAR_DNS_ALIAS` set to `alias` (or unset when
 * `undefined`), restoring the previous value afterwards so the surrounding
 * suite stays order-independent. The sidecar's Host guard reads `process.env`
 * per call, so scoping it around one `app.request()` is enough.
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
