import type { EditorTab } from "./types";

const TABS: { id: EditorTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "prompt", label: "Prompt" },
  { id: "services", label: "Services" },
  { id: "schema", label: "Schemas" },
  { id: "skills", label: "Skills" },
];

interface EditorTabsProps {
  activeTab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
}

export function EditorTabs({ activeTab, onTabChange }: EditorTabsProps) {
  return (
    <div className="exec-tabs">
      {TABS.map((tab) => (
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
