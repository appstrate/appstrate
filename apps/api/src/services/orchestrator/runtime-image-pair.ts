// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image pair coherence — `PI_IMAGE` and `SIDECAR_IMAGE` are a version
 * contract, and this module is what makes a broken one visible.
 *
 * ## The failure this exists for
 *
 * The agent runtime (`appstrate-pi`) and the sidecar (`appstrate-sidecar`)
 * speak a wire protocol to each other — LLM reverse proxy, `/mcp`, credential
 * injection — and both halves of it change in the same commit. A pair built
 * from two different commits starts normally, passes every health check, and
 * then fails somewhere upstream with a message that names neither image.
 *
 * Issue #1195 is the worked example: pi ≥ 0.79 started compressing the Codex
 * request body with zstd (#1167); the sidecar's oauth branch buffered that body
 * as text and corrupted it (fixed by #1166, merged twenty minutes before the
 * bump). Neither version was buggy on its own — only the pair was. What the
 * user saw was `run failed · {"detail":"Bad Request"}`, with not a word about
 * images, and the bisect that followed blamed the wrong commit.
 *
 * ## Two checks, deliberately different severities
 *
 * 1. {@link findRuntimeImageTagMismatch} — a **fail-fast boot gate** on the
 *    configured refs. Two refs pinned to different tags (`…-pi:v1.2.3` and
 *    `…-sidecar:v1.2.2`) is an operator mistake with no benign reading, it is
 *    detectable before anything starts, and every deployed environment is
 *    supposed to pin both from the same release. Refusing to boot is cheaper
 *    than the run failures it produces.
 *
 * 2. {@link warnOnRuntimeImageRevisionDrift} — a **warning** on the build
 *    stamps of the images actually on the host. Same tag can still mean two
 *    different builds (`:latest` rebuilt on one side only — the dominant dev
 *    failure), so this compares `org.opencontainers.image.revision` after the
 *    pre-pull. It only warns: a stamp can legitimately be absent (an image
 *    built before stamping, a third-party rebuild), and there is no reading of
 *    a label under which refusing to serve is the right answer.
 *
 * Both are Docker-specific by construction — they inspect image references and
 * image labels. Other backends own their own artifact locality.
 */

import * as docker from "../docker.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/** OCI label carrying the commit an image was built from. */
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";

/**
 * A revision label that carries no information. Both Dockerfiles default their
 * `BUILD_REVISION` ARG to this, so an unstamped image reports it rather than
 * omitting the label.
 */
const UNKNOWN_REVISION = "unknown";

interface ParsedImageRef {
  /** Everything before the tag / digest, registry host included. */
  readonly repository: string;
  /** Tag, defaulted to `latest` when the ref carries neither tag nor digest. */
  readonly tag: string | undefined;
  /** Digest (`sha256:…`) when the ref is digest-pinned. */
  readonly digest: string | undefined;
}

/**
 * Split a Docker image reference into repository / tag / digest.
 *
 * The one subtlety is that a registry host may carry a port (`localhost:5000/
 * appstrate-pi`), so a bare "last colon wins" split is wrong — the tag
 * separator is the last colon that appears *after* the last slash.
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

interface RuntimeImageTagMismatch {
  readonly piImage: string;
  readonly sidecarImage: string;
  readonly piTag: string;
  readonly sidecarTag: string;
}

/**
 * Compare the tags of the configured runtime-image pair.
 *
 * Returns `null` — "nothing to say" — whenever the comparison would be
 * meaningless rather than clean:
 *
 *  - either ref is digest-pinned with no tag: digests differ by construction
 *    (they identify different images), so there is nothing to compare.
 *
 * Everything else compares the two tags literally. `appstrate-pi` and
 * `appstrate-sidecar` both default to `latest`, so the zero-config dev setup
 * passes; `…-pi:v1.2.3` against `…-sidecar:v1.2.3` passes; the same pair with
 * one tag one release behind does not.
 */
export function findRuntimeImageTagMismatch(
  piImage: string,
  sidecarImage: string,
): RuntimeImageTagMismatch | null {
  const pi = parseImageRef(piImage);
  const sidecar = parseImageRef(sidecarImage);

  if (!pi.tag || !sidecar.tag) return null;
  if (pi.tag === sidecar.tag) return null;

  return {
    piImage,
    sidecarImage,
    piTag: pi.tag,
    sidecarTag: sidecar.tag,
  };
}

/**
 * Boot gate. Throws when `PI_IMAGE` and `SIDECAR_IMAGE` are pinned to
 * different tags. Call it only for backends that consume these refs
 * (`RUN_ADAPTER=docker`) — under the process adapter there are no images and
 * nothing to check.
 */
export function assertRuntimeImagePairPinned(piImage: string, sidecarImage: string): void {
  const mismatch = findRuntimeImageTagMismatch(piImage, sidecarImage);
  if (!mismatch) return;

  throw new Error(
    `PI_IMAGE and SIDECAR_IMAGE are pinned to different tags ` +
      `("${mismatch.piTag}" vs "${mismatch.sidecarTag}"): ` +
      `PI_IMAGE=${mismatch.piImage} SIDECAR_IMAGE=${mismatch.sidecarImage}. ` +
      `The agent runtime and the sidecar speak a wire protocol that changes in ` +
      `lockstep — a mismatched pair boots fine and then fails runs with an ` +
      `opaque upstream error (#1195). Pin both to the same release tag.`,
  );
}

interface RuntimeImageRevisionDeps {
  readonly piImage: string;
  readonly sidecarImage: string;
  /** Injection seam for tests. Defaults to the real Docker inspect. */
  readonly readImageLabels?: (image: string) => Promise<Record<string, string>>;
}

/**
 * Compare the build stamps of the two runtime images present on the host and
 * warn when they disagree. Never throws — see the module doc for why this half
 * is advisory.
 *
 * Returns the two revisions read, so callers and tests can assert on what was
 * compared rather than on log output.
 */
export async function warnOnRuntimeImageRevisionDrift(
  deps: RuntimeImageRevisionDeps,
): Promise<{ piRevision: string; sidecarRevision: string }> {
  const readLabels = deps.readImageLabels ?? docker.readImageLabels;

  let piRevision = UNKNOWN_REVISION;
  let sidecarRevision = UNKNOWN_REVISION;

  try {
    const [piLabels, sidecarLabels] = await Promise.all([
      readLabels(deps.piImage),
      readLabels(deps.sidecarImage),
    ]);
    piRevision = piLabels[OCI_REVISION_LABEL] ?? UNKNOWN_REVISION;
    sidecarRevision = sidecarLabels[OCI_REVISION_LABEL] ?? UNKNOWN_REVISION;
  } catch (err) {
    logger.warn("Could not read runtime image build stamps", {
      error: getErrorMessage(err),
    });
    return { piRevision, sidecarRevision };
  }

  // An unstamped image says nothing about the other half. Silence beats a
  // warning nobody can act on — the fix for a missing stamp is to rebuild with
  // `bun run docker:build:runtime`, which is also the fix for real drift, so a
  // real mismatch is never hidden for more than one rebuild.
  if (piRevision === UNKNOWN_REVISION || sidecarRevision === UNKNOWN_REVISION) {
    return { piRevision, sidecarRevision };
  }

  if (piRevision !== sidecarRevision) {
    logger.warn("runtime image pair built from different revisions", {
      piImage: deps.piImage,
      piRevision,
      sidecarImage: deps.sidecarImage,
      sidecarRevision,
      hint: "rebuild both with `bun run docker:build:runtime` — a mismatched pair fails runs with an opaque upstream error (#1195)",
    });
  }

  return { piRevision, sidecarRevision };
}
