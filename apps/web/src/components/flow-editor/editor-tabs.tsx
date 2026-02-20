import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EditorTab } from "./types";

interface EditorTabsProps {
  activeTab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
}

export function EditorTabs({ activeTab, onTabChange }: EditorTabsProps) {
  const { t } = useTranslation(["flows", "common"]);

  const tabs = useMemo(
    () => [
      { id: "general" as EditorTab, label: t("editor.tabGeneral") },
      { id: "prompt" as EditorTab, label: t("editor.tabPrompt") },
      { id: "services" as EditorTab, label: t("editor.tabServices") },
      { id: "schema" as EditorTab, label: t("editor.tabSchema") },
      { id: "skills" as EditorTab, label: t("editor.tabSkills") },
      { id: "extensions" as EditorTab, label: t("editor.tabExtensions") },
      { id: "json" as EditorTab, label: t("editor.tabJson") },
    ],
    [t],
  );

  return (
    <div className="exec-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tab${activeTab === tab.id ? " active" : ""}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
