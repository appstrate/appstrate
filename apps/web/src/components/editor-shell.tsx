import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "./spinner";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
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

  const breadcrumbs: BreadcrumbEntry[] = [
    { label: t("nav.orgSection", { ns: "common" }), href: "/" },
    { label: t(listLabel.key, { ns: listLabel.ns }), href: listPath },
  ];

  if (isEdit && packageId) {
    breadcrumbs.push({
      label: displayName || packageId,
      href: packageDetailPath(type, packageId),
    });
    breadcrumbs.push({ label: t("editor.breadcrumbEdit") });
  } else {
    breadcrumbs.push({ label: t(breadcrumbNewKeys[type]) });
  }

  const title = isEdit
    ? displayName || packageId || t("editor.breadcrumbEdit")
    : t(breadcrumbNewKeys[type]);

  return (
    <div className="space-y-4">
      <PageHeader title={title} breadcrumbs={breadcrumbs} />

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
