// SPDX-License-Identifier: Apache-2.0

import { asRecord } from "@appstrate/core/safe-json";

/** AFPS vendor extension controlling discovery, never authorization. */
export const VISIBILITY_META_NAMESPACE = "dev.appstrate/visibility";

/** An unlisted package remains resolvable by exact id but stays out of listings. */
export function isUnlisted(manifest: Record<string, unknown> | null | undefined): boolean {
  const visibility = asRecord(asRecord(manifest?._meta)[VISIBILITY_META_NAMESPACE]);
  return visibility.level === "unlisted";
}
