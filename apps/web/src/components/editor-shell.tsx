// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "./spinner";
import { PageHeader, type BreadcrumbEntry } from "./page-header";
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
  const { t } = useTranslation(["agents", "settings", "common"]);
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
    <div className="space-y-4 p-6">
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

      {!hideSubmitBar && (
        <div className="border-border mt-6 flex justify-end gap-2 border-t pt-4">
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
