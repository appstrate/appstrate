// SPDX-License-Identifier: Apache-2.0

import { ORG_LOGO_MAX_LENGTH, ORG_LOGO_WEBP_PREFIX } from "@appstrate/core/validation";

/**
 * A canvas encoding of the organization logo, as the server stores it: WebP within the
 * length limit, `null` when too long (the caller tries a smaller size). A browser that
 * cannot encode WebP hands back PNG, which the server refuses: `logo_processing`.
 */
export function storableLogo(encoded: string): string | null {
  if (!encoded.startsWith(ORG_LOGO_WEBP_PREFIX)) throw new Error("logo_processing");
  return encoded.length <= ORG_LOGO_MAX_LENGTH ? encoded : null;
}
