// SPDX-License-Identifier: Apache-2.0

import { formatBytes as formatBytesEn } from "@appstrate/core/format";
import i18n from "../i18n";

/**
 * `formatBytes` in the active language. French counts in octets (`o`, `Ko`, `Mo`, `Go`) and
 * writes a decimal comma; the tiers and the rounding stay those of `@appstrate/core/format`.
 */
export function formatBytes(bytes: number): string {
  const text = formatBytesEn(bytes);
  if (!i18n.language?.startsWith("fr")) return text;
  return text.replace(".", ",").replace(/B$/, "o");
}
