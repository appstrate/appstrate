// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";

/** A count in the interface's language, not the browser's (`toLocaleString()`). */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.language).format(value);
}
