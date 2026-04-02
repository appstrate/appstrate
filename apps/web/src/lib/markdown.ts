// SPDX-License-Identifier: Apache-2.0

import i18n from "../i18n";

export function formatDateField(dateStr: string | Date): string {
  try {
    const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
    return d.toLocaleString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(dateStr);
  }
}
