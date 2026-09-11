// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image build-stamp drift — the half of the `PI_IMAGE` /
 * `SIDECAR_IMAGE` version contract that only a live Docker host can answer.
 *
 * Why the pair is a contract at all, and the #1195 worked example, live with
 * the rule itself in `@appstrate/core/image-ref`. The *configuration* half —
 * both refs pinned to the same tag — is enforced fail-fast by the env schema
 * before anything starts, for every backend.
 *
 * What is left here: the same tag can still mean two different builds
 * (`:latest` rebuilt on one side only — the dominant dev failure), so after the
 * pre-pull we compare `org.opencontainers.image.revision` on the two images
 * actually present. It only warns. A stamp can legitimately be absent (an image
 * built before stamping, a third-party rebuild), and there is no reading of a
 * label under which refusing to serve is the right answer.
 */

import * as docker from "../docker.ts";
import { logger as defaultLogger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { OCI_REVISION_LABEL } from "@appstrate/core/image-ref";
import type { Logger } from "@appstrate/core/logger";

/**
 * A revision label that carries no information. Both Dockerfiles default their
 * `BUILD_REVISION` ARG to this, so an unstamped image reports it rather than
 * omitting the label.
 */
const UNKNOWN_REVISION = "unknown";

interface RuntimeImageRevisionDeps {
  readonly piImage: string;
  readonly sidecarImage: string;
  /** Injection seam for tests. Defaults to the real Docker inspect. */
  readonly readImageLabels?: (image: string) => Promise<Record<string, string>>;
  /**
   * Injection seam for tests, same idiom as `LocalQueue`'s constructor logger.
   * The warning IS the product of this function — the returned revisions are
   * only what it compared — so it has to be observable without a global module
   * mock, or a test cannot tell "detected drift" from "read two labels".
   */
  readonly logger?: Logger;
}

/**
 * Compare the build stamps of the two runtime images present on the host and
 * warn when they disagree. Never throws — see the module doc for why this half
 * is advisory.
 *
 * Returns the two revisions read, so a caller can report what was compared.
 * That return value is NOT the detection, though — a drifted pair and a matched
 * pair return the same shape — so the warning is emitted through the injected
 * `logger` seam and tests assert on the line itself.
 */
export async function warnOnRuntimeImageRevisionDrift(
  deps: RuntimeImageRevisionDeps,
): Promise<{ piRevision: string; sidecarRevision: string }> {
  const readLabels = deps.readImageLabels ?? docker.readImageLabels;
  const log = deps.logger ?? defaultLogger;

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
    log.warn("Could not read runtime image build stamps", {
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
    log.warn("runtime image pair built from different revisions", {
      piImage: deps.piImage,
      piRevision,
      sidecarImage: deps.sidecarImage,
      sidecarRevision,
      hint: "rebuild both with `bun run docker:build:runtime` — a mismatched pair fails runs with an opaque upstream error (#1195)",
    });
  }

  return { piRevision, sidecarRevision };
}
