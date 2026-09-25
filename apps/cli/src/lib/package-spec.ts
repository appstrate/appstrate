// SPDX-License-Identifier: Apache-2.0

/**
 * `<package>[@<spec>]`, the package reference `appstrate run` and
 * `appstrate packages pull` both take, as npm does.
 */

/** The platform's two reserved selectors: the draft, and the latest published version. */
export const DRAFT_SELECTOR = "draft";
export const PUBLISHED_SELECTOR = "published";

export class PackageSpecError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "PackageSpecError";
  }
}

/**
 * Split `<package>[@<spec>]` at the first `@` past the first character, so a
 * scope's leading `@` is never read as the separator. The spec is left for the
 * server to judge; an `@` with nothing after it is refused here.
 */
export function splitPackageSpec(raw: string): { ref: string; spec?: string } {
  const at = raw.indexOf("@", 1);
  if (at === -1) return { ref: raw };
  const spec = raw.slice(at + 1);
  if (spec.length === 0) {
    throw new PackageSpecError(
      `${raw}: nothing after "@".`,
      `Name a version, a range or a tag (${raw}1.2.0, ${raw}latest), or drop the "@".`,
    );
  }
  return { ref: raw.slice(0, at), spec };
}
