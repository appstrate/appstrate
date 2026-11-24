// SPDX-License-Identifier: Apache-2.0

import { formatDuration as formatElapsed } from "@appstrate/core/format";
import i18n from "../i18n";

export function formatDuration(ms: number): string {
  return formatElapsed(ms, i18n.language);
}
