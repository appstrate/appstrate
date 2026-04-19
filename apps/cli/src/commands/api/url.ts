// SPDX-License-Identifier: Apache-2.0

/**
 * Thrown when the request target resolves to a different origin than
 * the active profile's Appstrate instance. The whole point of
 * `appstrate api` is to inject a keyring-backed bearer — sending it to
 * a foreign host would leak the token, so we refuse loudly.
 */
export class HostMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `refusing to send bearer to foreign host.\n` +
        `  Expected origin: ${expected}\n` +
        `  Got:             ${actual}\n` +
        `  Hint: use \`curl\` directly for non-Appstrate hosts.`,
    );
    this.name = "HostMismatchError";
  }
}

export function buildUrl(instance: string, path: string, queryPairs: string[]): string {
  const instanceOrigin = new URL(instance).origin;
  let u: URL;
  // Detect absolute URLs (scheme://…) and validate the origin before
  // letting `new URL(path, instance)` silently swallow them — without
  // this guard an agent pasting `appstrate api https://evil/x` would
  // send the keyring-backed bearer to a foreign host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    u = new URL(path);
    if (u.origin !== instanceOrigin) {
      throw new HostMismatchError(instanceOrigin, u.origin);
    }
  } else {
    u = new URL(path, instance);
  }
  for (const raw of queryPairs) {
    const eq = raw.indexOf("=");
    if (eq === -1) {
      u.searchParams.append(raw, "");
    } else {
      u.searchParams.append(raw.slice(0, eq), raw.slice(eq + 1));
    }
  }
  return u.toString();
}
