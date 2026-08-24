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

import { isValidVersion, normalizeVersion } from "./semver.ts";

/** OCI label carrying the commit an image was built from. */
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

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
   * at build time. Anything that is not a release version (absent, empty,
   * `dev`, `health-container-e2e`, …) means "no release identity", which takes
   * the platform out of the comparison entirely.
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
 * The release version a value names, or `undefined` when it names none.
 *
 * The platform and the image tags are drawn from two different namespaces:
 * `APP_VERSION` is the git ref name the release workflow was triggered on
 * (`v1.0.0-beta.51`), while the image tags come from metadata-action's
 * `{{version}}` pattern (`1.0.0-beta.51`). Same release, one `v` apart — hence
 * the normalization, without which every released deployment would fail this
 * check.
 *
 * The predicate that follows the normalization is the load-bearing half. The
 * question is not "does this value have an identity?" but "is this a value an
 * image tag can be equal to?", and only a release version is. Everything else
 * a build stamps or a registry serves lives in a namespace where equality is
 * not defined:
 *
 *  - `dev` — the Dockerfile's `ARG APP_VERSION=dev`, and the string
 *    `apps/api/src/lib/version.ts` reports for a source run.
 *  - `health-container-e2e` — what `scripts/health-container-e2e.sh` builds
 *    with, against images tagged `:local`.
 *  - `latest`, `{{major}}.{{minor}}` (`1.0`) and `sha-<sha>` — the three
 *    *other* tag families `release.yml` publishes for the very same image as
 *    `{{version}}`. `:latest` is the documented compat fallback for consumers
 *    that skip the CLI, and every shipped compose file derives all three
 *    images from one `${APPSTRATE_VERSION}`, so pinning any of them presents a
 *    coherent trio.
 *
 * `semver.valid` is the arbiter: it accepts `1.0.0-beta.51` (with or without
 * the `v`) and rejects all six strings above. Requiring the round trip back to
 * the input keeps a hypothetical `:v1.0.0` tag out too — the comparison below
 * is literal, so a value that had to be rewritten to parse cannot be compared
 * against a raw tag without inventing a mismatch.
 */
function releaseVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeVersion(trimmed);
  return isValidVersion(normalized) ? normalized : undefined;
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
 * Compare the versions the members of the runtime-image contract claim, and
 * report the disagreement when there is one.
 *
 * The two halves of the rule are not symmetric, and conflating them is what
 * made an earlier version of it unsatisfiable outside a release build:
 *
 *  - **pi ↔ sidecar is always compared, literally.** Every shipped compose
 *    file sets both refs from one `${APPSTRATE_VERSION}`, and `.env.example`
 *    presents them as a pair, so any difference between the two is a half-done
 *    edit — whatever tag family it is in. `:latest` against `:1.0.0` is caught
 *    for the same reason `:1.0.0` against `:0.9.0` is.
 *  - **The platform joins only when all three values are release versions.**
 *    Its value is a git ref name, not a tag, so it can be *equal* to a tag only
 *    in the one family (`{{version}}`) the two namespaces share. Comparing it
 *    against `latest`, `1.0`, `sha-abc1234` or `local` does not detect skew: it
 *    rejects a coherent deployment and tells the operator to pin an image to a
 *    tag that was never published.
 *
 * Returns `null` — "nothing to say" — in three cases:
 *
 *  - **Either runtime ref is digest-pinned with no tag.** Digests identify
 *    images by content, so there is no version to compare, and one digest-
 *    pinned half silences the whole comparison: an operator pinning digests has
 *    taken explicit control of image identity.
 *  - **The platform has no release identity** (unset / empty / `dev` / any
 *    other non-version build stamp). It drops out and the rule degrades to
 *    exactly the pair rule it grew from — which is what keeps the zero-config
 *    dev box (`appstrate-pi:latest` + `appstrate-sidecar:latest`, run from
 *    source), every preview deployment, and the health-container e2e
 *    (`APP_VERSION=health-container-e2e` against `:local` images) passing.
 *  - **The images are pinned to a non-version tag family.** Same reason, from
 *    the other side: `release.yml` publishes `latest`, `{{major}}.{{minor}}`
 *    and `sha-<sha>` for the same image as `{{version}}`, and a deployment on
 *    any of them is coherent.
 *
 * What that last carve-out gives up, deliberately: a *versioned* platform with
 * both images floating on `:latest` is no longer rejected. It cannot be. The
 * platform's `APP_VERSION` is baked at build time and reads the same whether
 * the image was pulled by version tag or by `:latest`, so this function cannot
 * distinguish "operator hand-edited `.env` to float the runtime images" from
 * "operator runs the whole trio on `:latest`", which is a documented, supported
 * deployment. Tag comparison structurally cannot see it — the *same tag, two
 * builds* drift is exactly what the OCI-revision guard in
 * `apps/api/src/services/orchestrator/runtime-image-pair.ts` exists to catch,
 * by comparing the `org.opencontainers.image.revision` stamps of the images
 * actually present on the host.
 */
export function findRuntimeImageTagMismatch(
  trio: RuntimeImageTrio,
): RuntimeImageTagMismatch | null {
  const pi = parseImageRef(trio.piImage);
  const sidecar = parseImageRef(trio.sidecarImage);

  if (!pi.tag || !sidecar.tag) return null;

  const platformRelease = releaseVersion(trio.platformVersion);
  const platformVersion =
    platformRelease !== undefined &&
    releaseVersion(pi.tag) === pi.tag &&
    releaseVersion(sidecar.tag) === sidecar.tag
      ? platformRelease
      : undefined;

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
