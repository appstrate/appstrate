// SPDX-License-Identifier: Apache-2.0

/**
 * Every file of one definition of a package — its draft, or one published
 * version — as ONE archive download. The one code path `skills sync` and
 * `packages pull | status | push` read a package through, so the two cannot
 * disagree about what a definition contains.
 *
 * Both archives are unpacked by `unzipArtifact` under the package bounds, which
 * drops every entry `isSafeArchivePath` refuses. Entries come back unfiltered
 * otherwise (`manifest.json`, a published `RECORD`): what a caller keeps is its
 * own policy.
 */

import { apiFetchRaw, problemFields } from "./api.ts";
import { encodePackageIdPath } from "@appstrate/core/naming";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import {
  PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
  stripWrapperPrefix,
  unzipArtifact,
} from "@appstrate/core/zip";

/** The signature file of a published archive: produced by publishing, never authored. */
export const SIGNATURE_RECORD = "RECORD";

export class PackageDefinitionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    /** HTTP status of the refused download, when it was one. */
    public readonly status?: number,
    /** Problem `code` of the refused download, when it carried one. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PackageDefinitionError";
  }
}

type DefinitionRef =
  | {
      packageId: string;
      /** Names the permission a refusal points at. */
      type: PackageType;
      spaceId?: string;
      source: "draft";
      /** What the reader should do instead when the draft is not theirs. */
      refusalRemedy: string;
    }
  | {
      packageId: string;
      spaceId?: string;
      source: "published";
      /** `latest`, an exact version or a range. */
      version: string;
      /** Expected SRI when the caller resolved it first; the response header wins. */
      integrity?: string;
    };

/**
 * The draft is its author's working copy: every route that names it answers
 * `403 draft_not_writable` to whoever cannot write the package. "HTTP 403"
 * would send that reader hunting for a permission on the command itself, so
 * the refusal says whose copy it is, which grant reads it, and what to do.
 */
export function draftRefusal(
  packageId: string,
  type: PackageType,
  remedy: string,
): PackageDefinitionError {
  return new PackageDefinitionError(
    `The draft of ${packageId} is the author's working copy.`,
    `Reading it needs \`${PACKAGE_TYPE_ROUTE_SEGMENT[type]}:write\` on the ${type} in its home space. ${remedy}`,
    403,
    "draft_not_writable",
  );
}

export async function fetchPackageDefinition(
  profileName: string,
  ref: DefinitionRef,
): Promise<Record<string, Uint8Array>> {
  const base = `/api/packages/${encodePackageIdPath(ref.packageId)}`;
  const path =
    ref.source === "draft"
      ? `${base}/draft/download`
      : `${base}/${encodeURIComponent(ref.version)}/download`;
  const what =
    ref.source === "draft" ? `the draft of ${ref.packageId}` : `${ref.packageId}@${ref.version}`;
  const res = await apiFetchRaw(profileName, path, ref.spaceId ? { spaceId: ref.spaceId } : {});
  if (!res.ok) {
    const problem = problemFields(await res.json().catch(() => undefined));
    if (ref.source === "draft" && problem.code === "draft_not_writable") {
      throw draftRefusal(ref.packageId, ref.type, ref.refusalRemedy);
    }
    throw new PackageDefinitionError(
      `Download of ${what} failed: ${problem.detail ?? `HTTP ${res.status} ${res.statusText}`}`,
      undefined,
      res.status,
      problem.code,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (ref.source === "published") {
    // The header is what THIS response claims about THESE bytes; the resolved
    // value keeps the check meaningful on an instance that omits it.
    const advertised = res.headers.get("x-integrity") ?? ref.integrity;
    if (!advertised) {
      throw new PackageDefinitionError(
        `Download of ${what} carries no integrity to verify it against.`,
        "The instance is running an incompatible API version.",
      );
    }
    const verdict = verifyArtifactIntegrity(bytes, advertised);
    if (!verdict.valid) {
      throw new PackageDefinitionError(
        `Integrity mismatch for ${what}: expected ${advertised}, downloaded ${verdict.computed}`,
        "Retry. If it persists, the instance or a proxy is corrupting artifacts.",
      );
    }
  }
  // `unzipArtifact`, not `parsePackageZip`: the latter re-validates the
  // manifest with the author-input policy, which would make an old published
  // artifact (or a draft mid-edit) unreadable. Its bounds and wrapper handling
  // are kept explicitly.
  return stripWrapperPrefix(
    unzipArtifact(bytes, { maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES }),
  );
}
