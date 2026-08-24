// SPDX-License-Identifier: Apache-2.0

/**
 * Container image reference parsing, and the one consistency rule the platform
 * enforces over the runtime images it launches.
 *
 * The **platform itself**, `PI_IMAGE` (agent runtime) and `SIDECAR_IMAGE`
 * (credential-isolating proxy) are a *version contract*, not three independent
 * knobs. Two boundaries cut across the trio and both move in the same commit:
 *
 *  - **pi ↔ sidecar** speak a wire protocol to each other (LLM reverse proxy,
 *    `/mcp`, credential injection). A pair built from two different commits
 *    starts normally, passes every health check, and then fails runs with an
 *    error that names neither image (#1195: pi ≥ #1167 sends a zstd-compressed
 *    Codex body; sidecar < #1166 buffered it as text and corrupted it — neither
 *    version was buggy alone, only the pair was).
 *  - **platform ↔ runtime images** speak the container boundary (workspace
 *    layout, the routes the in-container uploader posts to). The same class of
 *    silent failure lives there: a runtime image from #1177 posts published
 *    files to `/runs/{id}/files`, which a platform one release older does not
 *    register, so every `publish_file` 404s, the run finishes with no
 *    deliverable, and nothing in the platform log says why.
 *
 * Which is why the rule is over the *trio*, not over the pair. Comparing the
 * two images only to each other leaves the platform-vs-runtime skew wide open:
 * a platform at version X with a matched pair at X−1 satisfies a pair rule
 * perfectly and still fails runs.
 *
 * Lives in core, not in the API, because the rule is enforced by the env schema
 * (`@appstrate/env`) at boot AND consulted by the platform's Docker
 * orchestrator. Nothing here talks to a container runtime — it is string
 * parsing over configuration.
 *
 * Tag comparison is one of two complementary guards, and it is the only one
 * answerable from configuration alone. The other —
 * `apps/api/src/services/orchestrator/runtime-image-pair.ts` — needs a live
 * Docker host: it compares the `org.opencontainers.image.revision` build stamps
 * of the two images actually present, catching a *same tag, two builds* drift
 * (`:latest` rebuilt on one side only) that tag comparison structurally cannot
 * see. Neither subsumes the other.
 */

/** OCI label carrying the commit an image was built from. */
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

/**
 * The build-identity string a platform carries when it has none.
 *
 * It is a real value, not an absence: the Dockerfile declares
 * `ARG APP_VERSION=dev`, so every image built without the release workflow's
 * build-arg reports `dev` rather than leaving `APP_VERSION` unset — and
 * `apps/api/src/lib/version.ts` reports the same string for a source run. Both
 * mean "this build has no release identity", so both are treated as unknown
 * here: a platform that cannot name its own version has nothing to compare the
 * runtime images against.
 */
const UNVERSIONED_BUILD = "dev";

export interface ParsedImageRef {
  /** Everything before the tag / digest, registry host included. */
  readonly repository: string;
  /** Tag, defaulted to `latest` when the ref carries neither tag nor digest. */
  readonly tag: string | undefined;
  /** Digest (`sha256:…`) when the ref is digest-pinned. */
  readonly digest: string | undefined;
}

/**
 * Split a container image reference into repository / tag / digest.
 *
 * The one subtlety is that a registry host may carry a port
 * (`localhost:5000/appstrate-pi`), so a bare "last colon wins" split is wrong —
 * the tag separator is the last colon that appears *after* the last slash.
 */
export function parseImageRef(ref: string): ParsedImageRef {
  const atIndex = ref.indexOf("@");
  const beforeDigest = atIndex === -1 ? ref : ref.slice(0, atIndex);
  const digest = atIndex === -1 ? undefined : ref.slice(atIndex + 1);

  const lastSlash = beforeDigest.lastIndexOf("/");
  const lastColon = beforeDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;

  return {
    repository: hasTag ? beforeDigest.slice(0, lastColon) : beforeDigest,
    // A digest-pinned ref without an explicit tag has no tag at all — do NOT
    // default it to `latest`, which would invent a mismatch against a
    // tag-pinned counterpart.
    tag: hasTag ? beforeDigest.slice(lastColon + 1) : digest ? undefined : "latest",
    digest,
  };
}

/** One member of the platform / pi / sidecar version trio. */
export type RuntimeImageMember = "platform" | "pi" | "sidecar";

/** The three refs the version contract holds over. */
export interface RuntimeImageTrio {
  /**
   * The platform's own build identity — `APP_VERSION`, stamped into the image
   * at build time. Absent, empty or `dev` means "no release identity", which
   * takes the platform out of the comparison entirely.
   */
  readonly platformVersion: string | undefined;
  readonly piImage: string;
  readonly sidecarImage: string;
}

export interface RuntimeImageTagMismatch {
  /**
   * The platform version as it was compared (leading `v` stripped), or
   * `undefined` when the platform took no part in the comparison.
   */
  readonly platformVersion: string | undefined;
  readonly piTag: string | undefined;
  readonly sidecarTag: string | undefined;
  /**
   * The member carrying a value the other two do not share, when exactly one
   * does. `undefined` when only two members were comparable, or when all three
   * values differ.
   *
   * This names the value that *stands alone*, NOT the thing to fix: a platform
   * at X with a matched pair at X−1 reports `"platform"`, and the fix there is
   * to move the two images.
   */
  readonly oddOneOut: RuntimeImageMember | undefined;
}

/**
 * `APP_VERSION` is the git ref name the release workflow was triggered on
 * (`v1.0.0-beta.51`); the image tags come from metadata-action's
 * `{{version}}` pattern (`1.0.0-beta.51`). Same release, one `v` apart — strip
 * it, or every released deployment would fail this check.
 *
 * Only a `v` immediately followed by a digit is a version prefix; a tag named
 * `vnext` is a tag named `vnext`.
 */
function normalizePlatformVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed || trimmed === UNVERSIONED_BUILD) return undefined;
  return /^v\d/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

interface ComparedMember {
  readonly member: RuntimeImageMember;
  readonly value: string;
}

function findOddOneOut(members: readonly ComparedMember[]): RuntimeImageMember | undefined {
  if (members.length < 3) return undefined;
  for (const candidate of members) {
    const others = members.filter((m) => m !== candidate);
    const [first] = others;
    if (!first) continue;
    if (others.every((m) => m.value === first.value) && first.value !== candidate.value) {
      return candidate.member;
    }
  }
  return undefined;
}

/**
 * Compare the versions the three members of the runtime-image contract claim,
 * and report the disagreement when there is one.
 *
 * Returns `null` — "nothing to say" — in two cases, both of them carve-outs
 * that predate the platform joining the comparison and whose semantics are
 * unchanged by it:
 *
 *  - **Either runtime ref is digest-pinned with no tag.** Digests identify
 *    images by content, so there is no version to compare, and one digest-
 *    pinned half silences the whole comparison: an operator pinning digests has
 *    taken explicit control of image identity.
 *  - **The platform has no build identity** (unset / empty / `dev`). It then
 *    simply drops out of the trio and the rule degrades to exactly the pair
 *    rule it grew from — which is what keeps the zero-config dev box
 *    (`appstrate-pi:latest` + `appstrate-sidecar:latest`, run from source) and
 *    every preview deployment (images stamped, platform built without
 *    `APP_VERSION`) passing.
 *
 * Everything else compares the tags literally, all comparable members at once.
 */
export function findRuntimeImageTagMismatch(
  trio: RuntimeImageTrio,
): RuntimeImageTagMismatch | null {
  const pi = parseImageRef(trio.piImage);
  const sidecar = parseImageRef(trio.sidecarImage);

  if (!pi.tag || !sidecar.tag) return null;

  const platformVersion = normalizePlatformVersion(trio.platformVersion);

  const members: ComparedMember[] = [
    ...(platformVersion ? [{ member: "platform" as const, value: platformVersion }] : []),
    { member: "pi" as const, value: pi.tag },
    { member: "sidecar" as const, value: sidecar.tag },
  ];

  const [first] = members;
  if (!first || members.every((m) => m.value === first.value)) return null;

  return {
    platformVersion,
    piTag: pi.tag,
    sidecarTag: sidecar.tag,
    oddOneOut: findOddOneOut(members),
  };
}
