// SPDX-License-Identifier: Apache-2.0

import { formatBytes as formatBytesIn } from "@appstrate/core/format";
import i18n from "../i18n";

/** `formatBytes` of `@appstrate/core/format`, bound to the language the interface is in. */
export function formatBytes(bytes: number): string {
  return formatBytesIn(bytes, i18n.language);
}
