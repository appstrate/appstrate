// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Braces, BrainCircuit, Code2, FileText, PackageOpen, Plug, Settings2 } from "lucide-react";
import { Spinner } from "./spinner";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
import { PanelDialog } from "./panel-dialog";
import { RailButton } from "./settings/rail-link";
import { packageDetailPath, packageListPath } from "../lib/package-paths";

// Only agent + skill have an editor route (see app.tsx).
type EditablePackageType = "agent" | "skill" | "integration";

const emojiMap: Record<EditablePackageType, string> = {
  agent: "⚡",
  skill: "🧠",
  integration: "🧩",
};

const breadcrumbNewKeys: Record<EditablePackageType, string> = {
  agent: "editor.breadcrumbNew",
  skill: "editor.breadcrumbNewSkill",
  integration: "editor.breadcrumbNewIntegration",
};

const listLabelKeys: Record<EditablePackageType, { key: string; ns?: string }> = {
  agent: { key: "detail.breadcrumb" },
  skill: { key: "packages.type.skills", ns: "settings" },
  integration: { key: "packages.type.integrations", ns: "settings" },
};

interface EditorTab {
  id: string;
  label: string;
}

interface EditorShellProps {
  type: EditablePackageType;
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
  presentation?: "page" | "panel-dialog";
  panelTitle?: string;
  activeDescription?: string;
  activeSecondaryDescription?: string;
  isDirty?: boolean;
  onDiscardChanges?: () => void;
  children: ReactNode;
}

const editorTabIcons = {
  general: Settings2,
  prompt: FileText,
  schema: Braces,
  skills: BrainCircuit,
  integrations: Plug,
  json: Code2,
  source: FileText,
  auths: Settings2,
  tools: Plug,
  content: FileText,
} as const;

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
  presentation = "page",
  panelTitle,
  activeDescription,
  activeSecondaryDescription,
  isDirty = false,
  onDiscardChanges,
  children,
}: EditorShellProps) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const listLabel = listLabelKeys[type];
  const listPath = packageListPath(type);

  const breadcrumbs: BreadcrumbEntry[] = [
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

  const submitBar = !hideSubmitBar && (
    <div className="border-border mt-6 flex justify-end gap-2 border-t pt-4">
      <Button variant="outline" type="button" onClick={onCancel}>
        {t("btn.cancel")}
      </Button>
      <Button type="button" onClick={onSubmit} disabled={isPending}>
        {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
      </Button>
    </div>
  );

  if (presentation === "panel-dialog") {
    const dialogTitle = panelTitle ?? title;
    const rail = (
      <div className="flex h-full flex-col">
        <div className="border-sidebar-border flex min-h-14 items-center gap-2 border-b px-4 text-sm font-semibold">
          <PackageOpen className="text-muted-foreground size-4" />
          <span className="truncate">{dialogTitle}</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-3" aria-label={dialogTitle}>
          {tabs.map((tab) => {
            const Icon = editorTabIcons[tab.id as keyof typeof editorTabIcons] ?? FileText;
            return (
              <RailButton
                key={tab.id}
                icon={Icon}
                label={tab.label}
                active={activeTab === tab.id}
                onClick={() => onTabChange(tab.id)}
              />
            );
          })}
        </nav>
      </div>
    );

    return (
      <PanelDialog
        title={dialogTitle}
        rail={rail}
        contentScrollArea
        reserveCloseArea
        closeLabel={t("btn.close")}
        contentFooter={
          !hideSubmitBar ? (
            <div className="bg-background border-border flex min-h-16 shrink-0 items-center gap-3 border-t px-6 py-3">
              <span className="text-muted-foreground text-sm">
                {isDirty ? t("unsaved.title", { ns: "common" }) : t("editor.noUnsavedChanges")}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  type="button"
                  onClick={onDiscardChanges}
                  disabled={!isDirty || !onDiscardChanges}
                >
                  {t("editor.discardChanges")}
                </Button>
                <Button type="button" onClick={onSubmit} disabled={!isDirty || isPending}>
                  {isPending ? <Spinner /> : t("btn.save")}
                </Button>
              </div>
            </div>
          ) : undefined
        }
        onClose={onCancel}
      >
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-semibold">
              {tabs.find((tab) => tab.id === activeTab)?.label}
            </h2>
            {activeDescription && (
              <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{activeDescription}</p>
            )}
            {activeSecondaryDescription && (
              <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
                {activeSecondaryDescription}
              </p>
            )}
          </div>
          {error && (
            <div className="bg-destructive/15 text-destructive rounded-md px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {children}
        </div>
      </PanelDialog>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={title} emoji={emojiMap[type]} breadcrumbs={breadcrumbs} />

      {error && (
        <div className="bg-destructive/15 text-destructive mb-4 rounded-md px-3 py-2 text-sm">
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

      {submitBar}
    </div>
  );
}
