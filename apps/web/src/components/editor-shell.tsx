// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Spinner } from "@appstrate/ui/components/spinner";
import { PageHeader } from "./page-header";
import { SettingsHeading } from "./settings/settings-heading";
import { packageListPath } from "../lib/package-paths";

/** Every type is edited embedded, in its Package AFPS; these three are also created on a page. */
export type EditablePackageType = "agent" | "skill" | "integration" | "mcp-server";
type CreatablePackageType = Exclude<EditablePackageType, "mcp-server">;

const createPages: Record<
  CreatablePackageType,
  { title: string; list: { key: string; ns?: string } }
> = {
  agent: { title: "editor.breadcrumbNew", list: { key: "detail.breadcrumb" } },
  skill: {
    title: "editor.breadcrumbNewSkill",
    list: { key: "packages.type.skills", ns: "settings" },
  },
  integration: {
    title: "editor.breadcrumbNewIntegration",
    list: { key: "packages.type.integrations", ns: "settings" },
  },
};

interface EditorTab {
  id: string;
  label: string;
}

interface EditorShellProps {
  type: EditablePackageType;
  tabs: EditorTab[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  error: string | null;
  isPending: boolean;
  onSubmit: () => void;
  hideSubmitBar?: boolean;
  /**
   * `page` to create; `embedded` inside a package's Définition, whose settings
   * rail already lists the sections, so the shell draws only the active one and
   * the save bar.
   */
  presentation?: "page" | "embedded";
  activeDescription?: string;
  isDirty?: boolean;
  onDiscardChanges?: () => void;
  children: ReactNode;
}

export function EditorShell({
  type,
  tabs,
  activeTab,
  onTabChange,
  error,
  isPending,
  onSubmit,
  hideSubmitBar = false,
  presentation = "page",
  activeDescription,
  isDirty = false,
  onDiscardChanges,
  children,
}: EditorShellProps) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const navigate = useNavigate();

  // Only when there is something to save, as the files explorer's bar is: a
  // permanent bar saying "nothing to save", with two dead buttons, is furniture.
  const embeddedFooter =
    !hideSubmitBar && (isDirty || isPending) ? (
      <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
        <span className="text-muted-foreground text-sm">
          {t("unsaved.title", { ns: "common" })}
        </span>
        <div className="ml-auto flex items-center gap-2 max-lg:ml-0 max-lg:w-full">
          <Button
            variant="outline"
            type="button"
            onClick={onDiscardChanges}
            disabled={isPending || !onDiscardChanges}
            className="max-lg:flex-1"
          >
            {t("editor.discardChanges")}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isPending} className="max-lg:flex-1">
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
            description={activeDescription}
          />
          {error && (
            <div className="bg-destructive/15 text-destructive rounded-md px-3 py-2 text-sm">
              {error}
            </div>
          )}
          <div inert={isPending} aria-busy={isPending} className="space-y-4">
            {children}
          </div>
        </div>
        {embeddedFooter}
      </div>
    );
  }

  // Only the three creatable types reach the page (`PackageEditorPage`).
  const page = createPages[type as CreatablePackageType];
  const listPath = packageListPath(type);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t(page.title)}
        breadcrumbs={[
          { label: t(page.list.key, { ns: page.list.ns }), href: listPath },
          { label: t(page.title) },
        ]}
      />

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

      {!hideSubmitBar && (
        <div className="border-border mt-6 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" type="button" onClick={() => navigate(listPath)}>
            {t("btn.cancel")}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.create")}
          </Button>
        </div>
      )}
    </div>
  );
}
