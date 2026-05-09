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
 * Errors map to four user-facing codes the run command formats:
 *   - `package_not_found`     — 404 on the agent (scope/name).
 *   - `version_not_found`     — 404 with a payload mentioning version.
 *   - `integrity_mismatch`    — server omitted the integrity header,
 *                               or the downloaded bytes failed to verify.
 *   - `bundle_fetch_failed`   — anything else (network, 5xx, …).
 */

import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";

export class BundleFetchError extends Error {
  constructor(
    public readonly code:
      | "package_not_found"
      | "package_not_installed_in_app"
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
  applicationId: string;
  orgId?: string;
  /** `@scope/name`. */
  packageId: string;
  /** Spec after `@` (semver, range, dist-tag); undefined → server-side default. */
  spec: string | undefined;
  /** Test-only fetch override. */
  fetchImpl?: typeof fetch;
}

export interface BundleFetchResult {
  /** Downloaded bundle bytes — verified against the server integrity header. */
  bytes: Uint8Array;
  /** Bundle SRI digest (`sha256-<base64>`) reported by the server. */
  integrity: string;
  /**
   * Resolved version label. Read from `X-Bundle-Version` (concrete semver
   * for published, literal `"draft"` for draft). Falls back to a
   * Content-Disposition parse on older servers, then to `"unspecified"`.
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
    "X-Application-Id": input.applicationId,
  };
  if (input.orgId) headers["X-Org-Id"] = input.orgId;

  const res = await fetchFn(url, { headers });
  if (res.status === 404) {
    const text = await safeText(res);
    // Server-issued problem+json carries a `code` field that distinguishes
    // the three 404 sub-cases. Parsing it here lets us surface a clearer
    // hint than the historical "not found — verify the agent is installed"
    // catch-all (which left users staring at the message wondering whether
    // their agent existed at all).
    const errorCode = parseProblemCode(text);
    if (errorCode === "agent_not_installed_in_app") {
      throw new BundleFetchError(
        "package_not_installed_in_app",
        `Package ${input.packageId} exists in your organization catalog but is not installed in the pinned application`,
        `Install it from the dashboard, or run:\n  appstrate api -X POST /api/applications/${input.applicationId}/packages -d '{"packageId":"${input.packageId}"}'`,
      );
    }
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
      "The agent does not exist in your organization catalog. Check the spelling or run `appstrate org list` to confirm you're pinned to the right org.",
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

  // Prefer the explicit `X-Bundle-Version` header (added when registry-
  // attribution landed); fall back to the Content-Disposition parse for
  // older servers, and finally to `"unspecified"`. The header value is
  // either a concrete semver (`1.2.3`, `1.2.3-rc.1`) or the literal
  // `"draft"` — propagate verbatim so the run-creation call can decide
  // between `source: "published" + spec` and `source: "draft"`.
  const versionHeader = res.headers.get("X-Bundle-Version") ?? res.headers.get("x-bundle-version");
  const version =
    versionHeader ??
    parseVersionFromContentDisposition(res.headers.get("Content-Disposition")) ??
    "unspecified";
  // `?source=draft` was sent ⇔ the server returned the draft. We don't
  // trust `versionHeader === "draft"` alone for this — the request shape
  // is the authoritative signal, and the response is a sanity check.
  const stage: "draft" | "published" = input.spec === undefined ? "draft" : "published";

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
  // No `--version` → `?source=draft`. Mirrors the dashboard "Run"
  // button: a never-published agent (or one with uncommitted edits)
  // must run from its current draft on both surfaces. Without this,
  // `appstrate run @scope/agent` fails with `no_published_version` on
  // an agent the UI runs happily — breaking the CLI<>UI parity promise.
  // `--version=X` opts back into the published-archive path.
  const base = `${instance}/api/agents/${scope}/${name}/bundle`;
  if (!spec) return `${base}?source=draft`;
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
