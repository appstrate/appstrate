// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch an `.afps-bundle` archive for `@scope/name[@spec]` from the
 * pinned Appstrate instance.
 *
 * The bytes live only in memory for the duration of the run — they are
 * verified against the server-issued `X-Bundle-Integrity` header,
 * handed to `readBundleFromBuffer`, and dropped when the run finishes.
 * No on-disk cache: a bundle is whatever the server says it is right
 * now, every invocation.
 *
 * Errors map to user-facing codes the run command formats:
 *   - `package_not_found`     — 404 on the agent (scope/name).
 *   - `no_published_version`  — 404 on an agent that exists but has never
 *                               been published.
 *   - `version_not_found`     — 404 with a payload mentioning version.
 *   - `version_artifact_unavailable` — 422: the published version exists
 *                               but its stored archive is missing, corrupt
 *                               or lacks its required entry.
 *   - `integrity_mismatch`    — server omitted the integrity header,
 *                               or the downloaded bytes failed to verify.
 *   - `bundle_fetch_failed`   — anything else (network, 5xx, …).
 */

import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";
import { DRAFT_SELECTOR, PUBLISHED_SELECTOR } from "../../lib/package-spec.ts";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";

export class BundleFetchError extends Error {
  constructor(
    public readonly code:
      | "package_not_found"
      | "package_not_active_in_space"
      | "no_published_version"
      | "version_not_found"
      | "version_artifact_unavailable"
      | "integrity_mismatch"
      | "bundle_fetch_failed",
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "BundleFetchError";
  }
}

interface BundleFetchInput {
  instance: string;
  bearerToken: string;
  spaceId: string;
  orgId?: string;
  /** `@scope/name`. */
  packageId: string;
  /**
   * Spec after `@` — a semver, a range, a dist-tag, or one of the two
   * reserved selectors the platform also honours on `?version=`:
   * `draft` (the author's working copy) and `published` (the latest
   * release). Undefined → the latest published version, same as every
   * other surface.
   */
  spec: string | undefined;
  /** Test-only fetch override. */
  fetchImpl?: typeof fetch;
}

interface BundleFetchResult {
  /** Downloaded bundle bytes — verified against the server integrity header. */
  bytes: Uint8Array;
  /** Bundle SRI digest (`sha256-<base64>`) reported by the server. */
  integrity: string;
  /**
   * Resolved version label. Read from `X-Bundle-Version` (concrete semver
   * for published, literal `"draft"` for draft).
   */
  version: string;
  /**
   * Whether the served bundle came from the package's draft state or a
   * published version. Drives the `stage` field on `POST /api/runs/remote`
   * `kind: "registry"`.
   */
  stage: "draft" | "published";
}

/**
 * Fetch the bundle for `<scope>/<name>[@spec]` from `<instance>` and
 * return the verified bytes in memory. Caller is responsible for
 * letting them go out of scope once the run is done.
 */
export async function fetchBundleForRun(input: BundleFetchInput): Promise<BundleFetchResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const instance = normalizeInstance(input.instance);
  const host = safeHost(instance);
  const [scope, name] = input.packageId.split("/") as [string, string];

  const url = buildBundleUrl(instance, scope, name, input.spec);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearerToken}`,
    "User-Agent": CLI_USER_AGENT,
    "X-Space-Id": input.spaceId,
  };
  if (input.orgId) headers["X-Org-Id"] = input.orgId;

  const res = await fetchFn(url, { headers });
  if (res.status === 404) {
    const text = await safeText(res);
    // Server-issued problem+json carries a `code` field that distinguishes
    // the 404 sub-cases. Parsing it here lets us surface a clearer
    // hint than the historical "not found — verify the agent is available"
    // catch-all (which left users staring at the message wondering whether
    // their agent existed at all).
    const errorCode = parseProblemCode(text);
    if (errorCode === "agent_not_active_in_space") {
      throw new BundleFetchError(
        "package_not_active_in_space",
        `Package ${input.packageId} exists in your organization but is not active in the pinned space`,
        `Activate it from the dashboard, or run:\n  appstrate api -X POST /api/spaces/${input.spaceId}/packages -d '{"packageId":"${input.packageId}"}'`,
      );
    }
    // The agent exists and is active — it just has no release. Say that,
    // and say what to do about it: the generic `package_not_found` fallback
    // below sends the user hunting for a typo in a name that is correct.
    if (errorCode === "no_published_version") {
      throw new BundleFetchError(
        "no_published_version",
        `Package ${input.packageId} has no published version`,
        `Publish a version from the dashboard, or run the author's working copy:\n  appstrate run ${input.packageId}@draft --local`,
      );
    }
    if (/version/i.test(text) && input.spec) {
      throw new BundleFetchError(
        "version_not_found",
        `No version of ${input.packageId} matches "${input.spec}"`,
        "Check the spec, or drop it to run the latest published version.",
      );
    }
    throw new BundleFetchError(
      "package_not_found",
      `Package ${input.packageId} not found on ${host}`,
      "The agent does not exist in your organization. Check the spelling or run `appstrate org list` to confirm you're pinned to the right org.",
    );
  }
  if (!res.ok) {
    const detail = await safeText(res);
    // A storage fault on the server, not a typo: the version is published but
    // its archive cannot be read. Any other 422 keeps the generic path below.
    if (res.status === 422 && parseProblemCode(detail) === "version_artifact_unavailable") {
      const target = input.spec ? `${input.packageId}@${input.spec}` : input.packageId;
      throw new BundleFetchError(
        "version_artifact_unavailable",
        `The published version of ${target} cannot be run: its stored archive is unreadable`,
        `The package author must republish it or delete the broken version. If you own it, run the working copy meanwhile:\n  appstrate run ${input.packageId}@draft --local`,
      );
    }
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

  // The header value is either a concrete semver (`1.2.3`, `1.2.3-rc.1`)
  // or the literal `"draft"` — propagate verbatim so the run-creation call
  // can decide between `source: "published" + spec` and `source: "draft"`.
  const versionHeader = res.headers.get("X-Bundle-Version") ?? res.headers.get("x-bundle-version");
  if (!versionHeader) {
    throw new BundleFetchError(
      "bundle_fetch_failed",
      "Server did not return X-Bundle-Version for the bundle response",
      "Upgrade the Appstrate instance — this header is required for run attribution.",
    );
  }
  const version = versionHeader;
  // `?source=draft` was sent ⇔ the server returned the draft, and only an
  // explicit `@draft` sends it. We don't trust `versionHeader === "draft"`
  // alone for this — the request shape is the authoritative signal, and the
  // response is a sanity check.
  const stage: "draft" | "published" = input.spec === DRAFT_SELECTOR ? "draft" : "published";

  const bytes = new Uint8Array(await res.arrayBuffer());
  // The bytes we just downloaded must match the server-issued integrity.
  // If the network or an upstream proxy mangled them we want to fail
  // loudly instead of feeding a corrupted archive into the run pipeline.
  const verdict = verifyArtifactIntegrity(bytes, integrity);
  if (!verdict.valid) {
    throw new BundleFetchError(
      "integrity_mismatch",
      `Bundle integrity mismatch: server advertised ${integrity}, downloaded ${verdict.computed}`,
      "Retry the command. If the failure persists, the instance or a network proxy is corrupting bundles.",
    );
  }

  return { bytes, integrity, version, stage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  // Don't encode scope/name. They're already validated by `package-spec.ts`
  // as `@[a-z0-9-]+/[a-z0-9-]+`, and `encodeURIComponent("@acme")` produces
  // `%40acme` which the server route `:scope{@[^/]+}` rejects as 404 —
  // Hono's RegExpRouter matches against the raw (encoded) path. The
  // version spec is encoded because it can include `+`, `>=`, etc.
  //
  // No spec → no `source`: the route's default is the latest published
  // version, which is what every other surface runs when nobody names a
  // version. The working copy belongs to whoever can write the package,
  // so it is reached only by SAYING so — `@scope/agent@draft` — and the
  // server answers `403 draft_not_writable` to anyone else. `@published`
  // is accepted for symmetry with the platform's `?version=` vocabulary:
  // both keywords are reserved dist-tag names, so neither can collide
  // with a real tag.
  const base = `${instance}/api/agents/${scope}/${name}/bundle`;
  if (!spec) return base;
  if (spec === DRAFT_SELECTOR || spec === PUBLISHED_SELECTOR) return `${base}?source=${spec}`;
  return `${base}?version=${encodeURIComponent(spec)}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Best-effort extraction of the `code` field from an RFC 9457
 * `application/problem+json` body. Returns null when the body isn't JSON
 * or the field is missing — callers fall back to the prior
 * substring-matching heuristics.
 */
function parseProblemCode(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>)["code"];
      if (typeof code === "string" && code.length > 0) return code;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}
