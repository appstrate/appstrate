// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch an `.afps-bundle` archive for `@scope/name[@spec]` from the
 * pinned Appstrate instance, with a content-addressed local cache.
 *
 * Cache layout:
 *   `~/.cache/appstrate/bundles/{instanceHost}/{scope}/{name}/{version}-{integrityShort}.afps-bundle`
 *
 *   - Including the instance host avoids cross-instance leakage when a
 *     user has multiple profiles pointing at different deployments.
 *   - The version + first 16 chars of the bundle integrity digest form a
 *     unique key per build. We re-fetch on cache miss but reuse the file
 *     when both match — `X-Bundle-Integrity` is the platform-side SRI
 *     digest of the canonical packages map and is safe to trust.
 *   - We deliberately do NOT cache the `spec → version` resolution: a
 *     dist-tag (`@latest`) or range (`@^1`) can resolve to a different
 *     version on the next call; the catalog is the source of truth.
 *
 * Errors map to four user-facing codes the run command formats:
 *   - `package_not_found`     — 404 on the agent (scope/name).
 *   - `version_not_found`     — 404 with a payload mentioning version.
 *   - `integrity_mismatch`    — server omitted the integrity header.
 *   - `bundle_fetch_failed`   — anything else (network, 5xx, …).
 */

import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";

export class BundleFetchError extends Error {
  constructor(
    public readonly code:
      | "package_not_found"
      | "version_not_found"
      | "integrity_mismatch"
      | "bundle_fetch_failed",
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "BundleFetchError";
  }
}

export interface BundleFetchInput {
  instance: string;
  bearerToken: string;
  appId: string;
  orgId?: string;
  /** `@scope/name`. */
  packageId: string;
  /** Spec after `@` (semver, range, dist-tag); undefined → server-side default. */
  spec: string | undefined;
  /** Skip cache lookup; still write through to cache after fetch. */
  noCache?: boolean;
  /** Test-only fetch override. */
  fetchImpl?: typeof fetch;
  /** Override cache root (defaults to `$XDG_CACHE_HOME/appstrate` or `~/.cache/appstrate`). */
  cacheRoot?: string;
  /** Emit informational messages (cache hit, cache miss). */
  onLog?: (message: string) => void;
}

export interface BundleFetchResult {
  /** Filesystem path of the cached `.afps-bundle` file. */
  path: string;
  /** Bundle SRI digest (`sha256-<base64>`) reported by the server. */
  integrity: string;
  /** Resolved version label (best-effort — parsed from `Content-Disposition`). */
  version: string;
  /** True when the cached file was reused without a network round-trip. */
  fromCache: boolean;
}

const INTEGRITY_PREFIX_LEN = 16;

/**
 * Fetch the bundle for `<scope>/<name>[@spec]` from `<instance>`. Cache
 * the resulting bytes keyed by `(instance, version, integrity)` and
 * return the cached file path.
 *
 * The implementation streams the response body to a temp file and
 * `rename(2)`s into the final location only after the integrity header
 * has been validated — partial writes from a Ctrl-C cannot poison the
 * cache.
 */
export async function fetchBundleForRun(input: BundleFetchInput): Promise<BundleFetchResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const root = input.cacheRoot ?? defaultCacheRoot();
  const instance = normalizeInstance(input.instance);
  const host = safeHost(instance);
  const [scope, name] = input.packageId.split("/") as [string, string];

  const url = buildBundleUrl(instance, scope, name, input.spec);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearerToken}`,
    "User-Agent": CLI_USER_AGENT,
    "X-App-Id": input.appId,
  };
  if (input.orgId) headers["X-Org-Id"] = input.orgId;

  const res = await fetchFn(url, { headers });
  if (res.status === 404) {
    const text = await safeText(res);
    if (/version/i.test(text) && input.spec) {
      throw new BundleFetchError(
        "version_not_found",
        `No version of ${input.packageId} matches "${input.spec}"`,
        "Check the spec or remove it to fall back to the version installed for this app.",
      );
    }
    throw new BundleFetchError(
      "package_not_found",
      `Package ${input.packageId} not found on ${host}`,
      "Verify the agent is installed (or system) on the pinned application.",
    );
  }
  if (!res.ok) {
    const detail = await safeText(res);
    throw new BundleFetchError(
      "bundle_fetch_failed",
      `Failed to fetch ${input.packageId}: HTTP ${res.status} ${res.statusText}${
        detail ? ` — ${detail.slice(0, 200)}` : ""
      }`,
    );
  }

  const integrity = res.headers.get("X-Bundle-Integrity") ?? res.headers.get("x-bundle-integrity");
  if (!integrity) {
    throw new BundleFetchError(
      "integrity_mismatch",
      "Server did not return X-Bundle-Integrity for the bundle response",
      "Upgrade the Appstrate instance — this header has been required since the bundle export landed.",
    );
  }

  const version =
    parseVersionFromContentDisposition(res.headers.get("Content-Disposition")) ?? "unspecified";
  const integrityShort = shortenIntegrity(integrity);
  const cachePath = computeCachePath(root, host, scope, name, version, integrityShort);

  if (!input.noCache && existsSync(cachePath)) {
    input.onLog?.(`bundle cache hit: ${cachePath}`);
    return { path: cachePath, integrity, version, fromCache: true };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, buf);
  try {
    await rename(tmp, cachePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  input.onLog?.(`bundle cached: ${cachePath}`);
  return { path: cachePath, integrity, version, fromCache: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "appstrate");
  return join(homedir(), ".cache", "appstrate");
}

function safeHost(instance: string): string {
  try {
    return new URL(instance).host;
  } catch {
    return instance.replace(/[^a-z0-9._-]/gi, "_");
  }
}

function buildBundleUrl(
  instance: string,
  scope: string,
  name: string,
  spec: string | undefined,
): string {
  const base = `${instance}/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/bundle`;
  if (!spec) return base;
  return `${base}?version=${encodeURIComponent(spec)}`;
}

function parseVersionFromContentDisposition(raw: string | null): string | null {
  if (!raw) return null;
  // Server emits filename="<scope>-<name>.afps-bundle.zip" — no version
  // string today. Future-proof: recognise filename*=… or a -X.Y.Z suffix
  // if the server starts encoding versions there.
  const versionInName = /-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\.afps-bundle/i.exec(raw);
  return versionInName?.[1] ?? null;
}

function shortenIntegrity(integrity: string): string {
  const sep = integrity.indexOf("-");
  const tail = sep >= 0 ? integrity.slice(sep + 1) : integrity;
  // Strip non-alphanumeric (base64 pad characters) and lowercase so the
  // shortened key is filesystem-safe across OSes.
  const sanitized = tail.replace(/[^A-Za-z0-9]/g, "");
  return sanitized.slice(0, INTEGRITY_PREFIX_LEN).toLowerCase() || "noint";
}

function computeCachePath(
  root: string,
  host: string,
  scope: string,
  name: string,
  version: string,
  integrityShort: string,
): string {
  const safeScope = scope.replace(/[^a-z0-9@_-]/gi, "_");
  const safeName = name.replace(/[^a-z0-9_-]/gi, "_");
  const safeVersion = version.replace(/[^a-z0-9._+-]/gi, "_");
  return join(
    root,
    "bundles",
    host,
    safeScope,
    safeName,
    `${safeVersion}-${integrityShort}.afps-bundle`,
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
