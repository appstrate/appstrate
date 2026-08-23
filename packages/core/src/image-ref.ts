// SPDX-License-Identifier: Apache-2.0

/**
 * Container image reference parsing, and the one consistency rule the platform
 * enforces over a pair of them.
 *
 * `PI_IMAGE` (agent runtime) and `SIDECAR_IMAGE` (credential-isolating proxy)
 * are a **version contract**: the two containers speak a wire protocol to each
 * other — LLM reverse proxy, `/mcp`, credential injection — and both halves of
 * it change in the same commit. A pair built from two different commits starts
 * normally, passes every health check, and then fails runs with an error that
 * names neither image (#1195: pi ≥ #1167 sends a zstd-compressed Codex body;
 * sidecar < #1166 buffered it as text and corrupted it — neither version was
 * buggy alone, only the pair was).
 *
 * Lives in core, not in the API, because the rule is enforced by the env schema
 * (`@appstrate/env`) at boot AND consulted by the platform's Docker
 * orchestrator. Nothing here talks to a container runtime — it is string
 * parsing over configuration.
 */

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

export interface ImageTagMismatch {
  readonly firstTag: string;
  readonly secondTag: string;
}

/**
 * Compare the tags of two image references that are supposed to ship together.
 *
 * Returns `null` — "nothing to say" — when either ref is digest-pinned with no
 * tag: digests identify different images by construction, so there is nothing
 * to compare and inventing a mismatch would be worse than staying silent.
 *
 * Everything else compares the two tags literally. `appstrate-pi` and
 * `appstrate-sidecar` both default to `latest`, so the zero-config dev setup
 * passes; `…-pi:1.2.3` against `…-sidecar:1.2.3` passes; the same pair with one
 * tag one release behind does not.
 */
export function findImageTagMismatch(first: string, second: string): ImageTagMismatch | null {
  const a = parseImageRef(first);
  const b = parseImageRef(second);

  if (!a.tag || !b.tag) return null;
  if (a.tag === b.tag) return null;

  return { firstTag: a.tag, secondTag: b.tag };
}
