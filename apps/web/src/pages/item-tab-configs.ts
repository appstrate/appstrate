import { usePackageList } from "../hooks/use-packages";

export interface ItemTabConfig {
  type: "skill" | "extension" | "provider";
  useData: () => {
    data:
      | {
          id: string;
          name?: string | null;
          description?: string | null;
          source?: "system" | "local";
          usedByFlows?: number;
          autoInstalled?: boolean;
        }[]
      | undefined;
    isLoading: boolean;
  };
  emptyMessageKey: string;
  emptyHintKey: string;
}

export const ITEM_TAB_CONFIGS: ItemTabConfig[] = [
  {
    type: "skill",
    useData: () => usePackageList("skill"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "extension",
    useData: () => usePackageList("extension"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
  {
    type: "provider",
    useData: () => usePackageList("provider"),
    emptyMessageKey: "packages.emptyItems",
    emptyHintKey: "packages.emptyItemsHint",
  },
];

export const skillTabConfig = ITEM_TAB_CONFIGS[0];
export const extensionTabConfig = ITEM_TAB_CONFIGS[1];
export const providerTabConfig = ITEM_TAB_CONFIGS[2];
