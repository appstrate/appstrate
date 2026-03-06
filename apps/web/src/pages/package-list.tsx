import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { type LucideIcon, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlows, usePackageList } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { ImportModal } from "../components/import-modal";
import { PackageCard } from "../components/package-card";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";

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
    <Button variant="outline" onClick={() => setImportOpen(true)}>
      {t("list.import")}
    </Button>
  );

  const header = (
    <div className="flex items-center justify-end gap-2 mb-4">
      <div className="flex items-center gap-2">
        {isOrgAdmin && extraActions}
        {importButton}
      </div>
    </div>
  );

  const modal = <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />;

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
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
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
            <Button>{t("list.create")}</Button>
          </Link>
        ) : undefined
      }
    />
  );
}

interface ItemTabConfig {
  type: "skill" | "extension";
  useData: () => {
    data:
      | {
          id: string;
          name?: string | null;
          description?: string | null;
          source?: "built-in" | "local";
          usedByFlows?: number;
        }[]
      | undefined;
    isLoading: boolean;
  };
  emptyMessageKey: string;
  emptyHintKey: string;
}

const ITEM_TAB_CONFIGS: ItemTabConfig[] = [
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
];

function ItemTab({ config }: { config: ItemTabConfig }) {
  const { t } = useTranslation(["settings", "flows", "common"]);
  const { isOrgAdmin } = useOrg();
  const { data: rawItems, isLoading } = config.useData();

  const typeLabel = t(`packages.type.${config.type}`);
  const items: CardItem[] | undefined = rawItems?.map((item) => ({
    id: item.id,
    displayName: item.name || item.id,
    description: item.description,
    type: config.type,
    source: item.source,
    usedByFlows: item.usedByFlows,
  }));

  return (
    <PackageTab
      items={items}
      isLoading={isLoading}
      emptyMessage={t(config.emptyMessageKey, { type: typeLabel })}
      emptyHint={t(config.emptyHintKey, { type: typeLabel })}
      extraActions={
        isOrgAdmin ? (
          <Link to={`/${config.type}s/new`}>
            <Button>{t("list.createItem", { ns: "flows" })}</Button>
          </Link>
        ) : undefined
      }
    />
  );
}

const skillTabConfig = ITEM_TAB_CONFIGS[0];
const extensionTabConfig = ITEM_TAB_CONFIGS[1];

export function PackageList() {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const [tab, setTab] = useTabWithHash<TabType>(["flows", "skills", "extensions"], "flows");

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabType)}>
        <TabsList>
          <TabsTrigger value="flows">{t("list.tabFlows", { ns: "flows" })}</TabsTrigger>
          <TabsTrigger value="skills">{t("list.tabSkills", { ns: "flows" })}</TabsTrigger>
          <TabsTrigger value="extensions">{t("list.tabExtensions", { ns: "flows" })}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {tab === "flows" && <FlowsTab />}
        {tab === "skills" && <ItemTab config={skillTabConfig} />}
        {tab === "extensions" && <ItemTab config={extensionTabConfig} />}
      </div>
    </>
  );
}
