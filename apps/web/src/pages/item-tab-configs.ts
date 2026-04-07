// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import { Plug, Puzzle, Wrench } from "lucide-react";
import { usePackageList } from "../hooks/use-packages";

export interface ItemTabConfig {
  type: "skill" | "tool" | "provider";
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

const ITEM_TAB_CONFIGS: ItemTabConfig[] = [
  {
    type: "skill",
    useData: () => usePackageList("skill"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
    emptyIcon: Wrench,
  },
  {
    type: "tool",
    useData: () => usePackageList("tool"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
    emptyIcon: Puzzle,
  },
  {
    type: "provider",
    useData: () => usePackageList("provider"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
    emptyIcon: Plug,
  },
];

export const skillTabConfig: ItemTabConfig = ITEM_TAB_CONFIGS[0]!;
export const toolTabConfig: ItemTabConfig = ITEM_TAB_CONFIGS[1]!;
export const providerTabConfig: ItemTabConfig = ITEM_TAB_CONFIGS[2]!;
