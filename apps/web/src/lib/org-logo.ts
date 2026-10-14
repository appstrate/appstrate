// SPDX-License-Identifier: Apache-2.0

import { ORG_LOGO_MAX_BYTES } from "@appstrate/core/validation";
import type { components } from "../api/client";

/** An organization logo as the API returns it: one emoji, or the URL of its image. */
export type OrgLogo = NonNullable<components["schemas"]["Organization"]["logo"]>;

/**
 * A canvas encoding of the organization logo, as the server accepts it: WebP within the
 * size limit, `null` when too large (the caller tries a smaller size). A browser that
 * cannot encode WebP hands back PNG, which the server refuses: `logo_processing`.
 */
export function storableLogo(encoded: Blob): Blob | null {
  if (encoded.type !== "image/webp") throw new Error("logo_processing");
  return encoded.size <= ORG_LOGO_MAX_BYTES ? encoded : null;
}
