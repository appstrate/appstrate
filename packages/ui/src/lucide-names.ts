// SPDX-License-Identifier: Apache-2.0

import { iconNames, type IconName } from "lucide-react/dynamic";

const LUCIDE_NAMES = new Set<string>(iconNames);

/** Whether `name` is an icon of the Lucide bundle, drawable by `DynamicIcon`. */
export function isLucideName(name: string): name is IconName {
  return LUCIDE_NAMES.has(name);
}
