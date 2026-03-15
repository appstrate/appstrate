import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "./spinner";
import type { PackageType } from "@appstrate/shared-types";
import { packageDetailPath, packageListPath } from "../lib/package-paths";

const breadcrumbNewKeys: Record<PackageType, string> = {
  flow: "editor.breadcrumbNew",
  skill: "editor.breadcrumbNewSkill",
  tool: "editor.breadcrumbNewTool",
  provider: "editor.breadcrumbNewProvider",
};

const listLabelKeys: Record<PackageType, { key: string; ns?: string }> = {
  flow: { key: "detail.breadcrumb" },
  skill: { key: "packages.type.skills", ns: "settings" },
  tool: { key: "packages.type.tools", ns: "settings" },
  provider: { key: "packages.type.providers", ns: "settings" },
};

interface EditorTab {
  id: string;
  label: string;
}

interface EditorShellProps {
  type: PackageType;
  packageId: string | undefined;
  isEdit: boolean;
  displayName: string | undefined;
  tabs: EditorTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  error: string | null;
  isPending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  /** Hide submit bar for certain tabs (e.g. JSON preview). Defaults to showing. */
  hideSubmitBar?: boolean;
  children: ReactNode;
}

export function EditorShell({
  type,
  packageId,
  isEdit,
  displayName,
  tabs,
  activeTab,
  onTabChange,
  error,
  isPending,
  onSubmit,
  onCancel,
  hideSubmitBar = false,
  children,
}: EditorShellProps) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const listLabel = listLabelKeys[type];
  const listPath = packageListPath(type);

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to={listPath} className="text-muted-foreground hover:text-foreground">
          {t(listLabel.key, { ns: listLabel.ns })}
        </Link>
        <span className="opacity-50">/</span>
        {isEdit && packageId ? (
          <>
            <Link
              to={packageDetailPath(type, packageId)}
              className="text-muted-foreground hover:text-foreground"
            >
              {displayName || packageId}
            </Link>
            <span className="opacity-50">/</span>
            <span>{t("editor.breadcrumbEdit")}</span>
          </>
        ) : (
          <span>{t(breadcrumbNewKeys[type])}</span>
        )}
      </nav>

      {error && (
        <div className="mb-4 rounded-md bg-destructive/15 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange} className="mb-4">
        <TabsList className="overflow-x-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {children}

      {!hideSubmitBar && (
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-border">
          <Button variant="outline" type="button" onClick={onCancel}>
            {t("btn.cancel")}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
          </Button>
        </div>
      )}
    </div>
  );
}
