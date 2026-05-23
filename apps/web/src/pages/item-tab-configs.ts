// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import { Wrench } from "lucide-react";
import { usePackageList } from "../hooks/use-packages";

export interface ItemTabConfig {
  type: "skill";
  useData: () => {
    data:
      | {
          id: string;
          name?: string | null;
          description?: string | null;
          source?: "system" | "local";
          usedByAgents?: number;
          autoInstalled?: boolean;
        }[]
      | undefined;
    isLoading: boolean;
  };
  emptyMessageKey: string;
  emptyHintKey: string;
  emptyIcon: LucideIcon;
}

export const skillTabConfig: ItemTabConfig = {
  type: "skill",
  useData: () => usePackageList("skill"),
  emptyMessageKey: "packages.emptyItems",
  emptyHintKey: "packages.emptyItemsHint",
  emptyIcon: Wrench,
};
