// SPDX-License-Identifier: Apache-2.0

import { ORG_LOGO_IMAGE_PREFIX, ORG_LOGO_MAX_BYTES } from "@appstrate/core/validation";

/**
 * A canvas encoding of the organization logo, as the server accepts it: WebP within the
 * size limit, `null` when too large (the caller tries a smaller size). A browser that
 * cannot encode WebP hands back PNG, which the server refuses: `logo_processing`.
 */
export function storableLogo(encoded: Blob): Blob | null {
  if (encoded.type !== "image/webp") throw new Error("logo_processing");
  return encoded.size <= ORG_LOGO_MAX_BYTES ? encoded : null;
}

/** Where an `image:<version>` logo is served, null for an emoji or no logo. */
export function orgLogoUrl(orgId: string, logo: string | null | undefined): string | null {
  if (!logo?.startsWith(ORG_LOGO_IMAGE_PREFIX)) return null;
  const version = logo.slice(ORG_LOGO_IMAGE_PREFIX.length);
  return `/api/orgs/${encodeURIComponent(orgId)}/logo?v=${encodeURIComponent(version)}`;
}
