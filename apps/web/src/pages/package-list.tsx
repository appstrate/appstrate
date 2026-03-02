import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import { useFlows } from "../hooks/use-flows";
import { useOrgSkills, useOrgExtensions } from "../hooks/use-library";
import { useOrg } from "../hooks/use-org";
import { ImportModal } from "../components/import-modal";
import { PackageCard } from "../components/package-card";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

type TabType = "flows" | "skills" | "extensions";

interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: "flow" | "skill" | "extension";
  source?: "built-in" | "local";
  runningExecutions?: number;
  tags?: string[];
  usedByFlows?: number;
}

interface PackageTabProps {
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: string;
  emptyIcon?: LucideIcon;
  extraActions?: ReactNode;
}

function PackageTab({
  items,
  isLoading,
  error,
  emptyMessage,
  emptyHint,
  emptyIcon,
  extraActions,
}: PackageTabProps) {
  const { t } = useTranslation(["flows"]);
  const { isOrgAdmin } = useOrg();
  const [importOpen, setImportOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const importButton = (
    <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
  );

  const header = (
    <div className="flow-list-header">
      <div />
      <div className="flow-list-actions">
        {isOrgAdmin && extraActions}
        {importButton}
      </div>
    </div>
  );

  const modal = (
    <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
  );

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {isOrgAdmin && extraActions}
          {importButton}
        </EmptyState>
        {modal}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="flow-grid">
        {items.map((item) => (
          <PackageCard key={item.id} {...item} />
        ))}
      </div>
      {modal}
    </>
  );
}

function FlowsTab() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();

  const items: CardItem[] | undefined = flows?.map((f) => ({
    id: f.id,
    displayName: f.displayName,
    description: f.description,
    type: "flow",
    source: f.source,
    runningExecutions: f.runningExecutions,
    tags: f.tags,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      error={error}
      emptyMessage={t("list.empty")}
      emptyHint={t("list.emptyHint")}
      emptyIcon={Layers}
      extraActions={
        isOrgAdmin ? (
          <Link to="/flows/new">
            <button>{t("list.create")}</button>
          </Link>
        ) : undefined
      }
    />
  );
}

function SkillsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: rawItems, isLoading } = useOrgSkills();

  const items: CardItem[] | undefined = rawItems?.map((s) => ({
    id: s.id,
    displayName: s.name || s.id,
    description: s.description,
    type: "skill",
    source: s.source,
    usedByFlows: s.usedByFlows,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      emptyMessage={t("library.emptySkill")}
      emptyHint={t("library.emptySkillHint")}
    />
  );
}

function ExtensionsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: rawItems, isLoading } = useOrgExtensions();

  const items: CardItem[] | undefined = rawItems?.map((e) => ({
    id: e.id,
    displayName: e.name || e.id,
    description: e.description,
    type: "extension",
    source: e.source,
    usedByFlows: e.usedByFlows,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      emptyMessage={t("library.emptyExtension")}
      emptyHint={t("library.emptyExtensionHint")}
    />
  );
}

export function PackageList() {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabType = tabParam === "skills" || tabParam === "extensions" ? tabParam : "flows";

  const setTab = (newTab: TabType) => {
    if (newTab === "flows") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: newTab }, { replace: true });
    }
  };

  return (
    <>
      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "flows"}
          className={`tab ${tab === "flows" ? "active" : ""}`}
          onClick={() => setTab("flows")}
        >
          {t("list.tabFlows", { ns: "flows" })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "skills"}
          className={`tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
        >
          {t("list.tabSkills", { ns: "flows" })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "extensions"}
          className={`tab ${tab === "extensions" ? "active" : ""}`}
          onClick={() => setTab("extensions")}
        >
          {t("list.tabExtensions", { ns: "flows" })}
        </button>
      </div>

      {tab === "flows" && <FlowsTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "extensions" && <ExtensionsTab />}
    </>
  );
}
