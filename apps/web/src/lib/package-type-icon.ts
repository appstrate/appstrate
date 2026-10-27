// SPDX-License-Identifier: Apache-2.0

import { Boxes, Layers, Plug, Wrench, type LucideIcon } from "lucide-react";
import type { PackageType } from "@appstrate/shared-types";

/** The glyph that stands for a package type wherever a type is named. */
export const PACKAGE_TYPE_ICON: Record<PackageType, LucideIcon> = {
  agent: Layers,
  skill: Wrench,
  "mcp-server": Plug,
  integration: Boxes,
};
