// SPDX-License-Identifier: Apache-2.0

import { ActivityIcon, FilesIcon, InfoIcon, LayoutListIcon, WrenchIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAdmittingSpaces } from "../../hooks/use-overview-mode";
import type { ConversationSidebarTab } from "./conversation-sidebar-state";

/**
 * `chat:read` opens the page, not the runs and files two tabs list. A selected
 * tab the caller can no longer see resolves to the summary, which always stays, as do Tools and Info.
 */
export function useConversationTabs(selected: ConversationSidebarTab) {
  const { t } = useTranslation("chat");
  // Any space's grants: a conversation lists the runs and files of every space it acted in.
  const runs = useAdmittingSpaces("runs", "chat").length > 0;
  const files = useAdmittingSpaces("files", "chat").length > 0;
  const readable: Record<ConversationSidebarTab, boolean> = {
    summary: true,
    runs,
    files,
    tools: true,
    info: true,
  };
  const tabs = (
    [
      { id: "summary", Icon: LayoutListIcon, label: t("context.tabs.summary") },
      { id: "runs", Icon: ActivityIcon, label: t("common:nav.runs") },
      { id: "files", Icon: FilesIcon, label: t("common:nav.files") },
      { id: "tools", Icon: WrenchIcon, label: t("context.tabs.tools") },
      { id: "info", Icon: InfoIcon, label: t("context.tabs.info") },
    ] as const satisfies readonly {
      id: ConversationSidebarTab;
      Icon: typeof LayoutListIcon;
      label: string;
    }[]
  ).filter(({ id }) => readable[id]);
  return {
    tabs,
    activeTab: tabs.find(({ id }) => id === selected) ?? tabs.find(({ id }) => id === "summary")!,
  };
}
