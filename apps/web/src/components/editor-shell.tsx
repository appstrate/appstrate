// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@appstrate/ui/components/select";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import {
  Braces,
  BrainCircuit,
  Code2,
  FileText,
  KeyRound,
  PackageOpen,
  Plug,
  Server,
  Settings2,
  Wrench,
} from "lucide-react";
import { Spinner } from "./spinner";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
import { PanelDialog } from "./panel-dialog";
import { SettingsHeading } from "./settings/settings-heading";
import { RailButton } from "./settings/rail-link";
import { packageDetailPath, packageListPath } from "../lib/package-paths";

/** Every type is edited in its Package AFPS; only the page (create) shows the emoji and breadcrumb. */
type EditablePackageType = "agent" | "skill" | "integration" | "mcp-server";

const emojiMap: Record<EditablePackageType, string> = {
  agent: "⚡",
  skill: "🧠",
  integration: "🧩",
  "mcp-server": "🔌",
};

const breadcrumbNewKeys: Record<EditablePackageType, string> = {
  agent: "editor.breadcrumbNew",
  skill: "editor.breadcrumbNewSkill",
  integration: "editor.breadcrumbNewIntegration",
  "mcp-server": "editor.breadcrumbEdit",
};

const listLabelKeys: Record<EditablePackageType, { key: string; ns?: string }> = {
  agent: { key: "detail.breadcrumb" },
  skill: { key: "packages.type.skills", ns: "settings" },
  integration: { key: "packages.type.integrations", ns: "settings" },
  "mcp-server": { key: "packages.type.mcp-servers", ns: "settings" },
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
  /**
   * `page` to create; `embedded` inside a package's Définition, whose settings
   * rail already lists the sections, so the shell draws only the active one and
   * the save bar.
   */
  presentation?: "page" | "panel-dialog" | "embedded";
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
  source: Server,
  auths: KeyRound,
  tools: Wrench,
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

  const embeddedFooter = !hideSubmitBar ? (
    <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
      <span className="text-muted-foreground text-sm">
        {isDirty ? t("unsaved.title", { ns: "common" }) : t("editor.noUnsavedChanges")}
      </span>
      <div className="ml-auto flex items-center gap-2 max-lg:ml-0 max-lg:w-full">
        <Button
          variant="outline"
          type="button"
          onClick={onDiscardChanges}
          disabled={!isDirty || !onDiscardChanges}
          className="max-lg:flex-1"
        >
          {t("editor.discardChanges")}
        </Button>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!isDirty || isPending}
          className="max-lg:flex-1"
        >
          {isPending ? <Spinner /> : t("btn.save")}
        </Button>
      </div>
    </div>
  ) : null;

  if (presentation === "embedded") {
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex-1 space-y-4 p-6">
          <SettingsHeading
            title={tabs.find((tab) => tab.id === activeTab)?.label}
            description={
              activeDescription || activeSecondaryDescription ? (
                <>
                  {activeDescription}
                  {activeSecondaryDescription && (
                    <p className="mt-2">{activeSecondaryDescription}</p>
                  )}
                </>
              ) : undefined
            }
          />
          {error && (
            <div className="bg-destructive/15 text-destructive rounded-md px-3 py-2 text-sm">
              {error}
            </div>
          )}
          {children}
        </div>
        {embeddedFooter}
      </div>
    );
  }

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
        mobileNav={
          <Select value={activeTab} onValueChange={onTabChange}>
            <SelectTrigger aria-label={dialogTitle}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabs.map((tab) => (
                <SelectItem key={tab.id} value={tab.id}>
                  {tab.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        contentScrollArea
        reserveCloseArea
        closeLabel={t("btn.close")}
        contentFooter={
          !hideSubmitBar ? (
            <div className="bg-background border-border flex min-h-16 shrink-0 items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
              <span className="text-muted-foreground text-sm">
                {isDirty ? t("unsaved.title", { ns: "common" }) : t("editor.noUnsavedChanges")}
              </span>
              <div className="ml-auto flex items-center gap-2 max-lg:ml-0 max-lg:w-full">
                <Button
                  variant="outline"
                  type="button"
                  onClick={onDiscardChanges}
                  className="max-lg:min-w-0 max-lg:flex-1 max-lg:px-2 max-lg:text-xs"
                  disabled={!isDirty || !onDiscardChanges}
                >
                  {t("editor.discardChanges")}
                </Button>
                <Button
                  type="button"
                  onClick={onSubmit}
                  disabled={!isDirty || isPending}
                  className="max-lg:min-w-0 max-lg:flex-1 max-lg:px-2 max-lg:text-xs"
                >
                  {isPending ? <Spinner /> : t("btn.save")}
                </Button>
              </div>
            </div>
          ) : undefined
        }
        onClose={onCancel}
      >
        <div className="space-y-4">
          <SettingsHeading
            title={tabs.find((tab) => tab.id === activeTab)?.label}
            description={
              activeDescription || activeSecondaryDescription ? (
                <>
                  {activeDescription}
                  {activeSecondaryDescription && (
                    <p className="mt-2">{activeSecondaryDescription}</p>
                  )}
                </>
              ) : undefined
            }
          />
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

      <div inert={isPending} aria-busy={isPending}>
        {children}
      </div>

      {submitBar}
    </div>
  );
}
