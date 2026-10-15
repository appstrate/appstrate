// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  agentSchema,
  skillSchema,
  integrationSchema,
  mcpServerSchema,
} from "@appstrate/core/schemas";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { JsonEditor } from "../json-editor";
import { PackageFilesEditor } from "../package-files/package-files-editor";
import { ManifestEditEntry } from "../package-files/package-files-section";
import { PageHeader } from "../page-header";
import { SettingsHeading } from "../settings/settings-heading";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { packageListPath } from "../../lib/package-paths";
import type { PackageEditor, PackageEditorTab } from "./use-package-editor";

/** Every type is edited in its Package AFPS; these three are also created on a page. */
export type EditablePackageType = "agent" | "skill" | "integration" | "mcp-server";
type CreatablePackageType = Exclude<EditablePackageType, "mcp-server">;

const PACKAGE_SCHEMAS: Record<EditablePackageType, object> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
  "mcp-server": mcpServerSchema,
};

const createPages: Record<
  CreatablePackageType,
  { title: string; list: { key: string; ns?: string } }
> = {
  agent: { title: "list.create", list: { key: "detail.breadcrumb" } },
  skill: {
    title: "editor.breadcrumbNewSkill",
    list: { key: "packages.type.skills", ns: "settings" },
  },
  integration: {
    title: "editor.breadcrumbNewIntegration",
    list: { key: "packages.type.integrations", ns: "settings" },
  },
};

/** What every package editor draws around its sections: page chrome to create, or when editing only the open section and save bar; plus the raw manifest, files tab and unsaved-changes guard. */
export function PackageEditorFrame({
  editor,
  tabs,
  descriptions,
  children,
}: {
  editor: PackageEditor;
  tabs: Array<{ id: PackageEditorTab; label: string }>;
  /** Editing: the line under the open section's heading. */
  descriptions?: Partial<Record<PackageEditorTab, string>>;
  children: ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const navigate = useNavigate();
  const { type, packageId, isEdit, state, setState, activeTab, setActiveTab, isPending } = editor;
  const schema = { uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] };

  const body = (
    <div inert={isPending} aria-busy={isPending} className={isEdit ? "space-y-4" : undefined}>
      {children}
      {isEdit ? (
        <ManifestEditEntry
          value={state.manifest}
          schema={schema}
          onApply={editor.replaceManifest}
        />
      ) : (
        <>
          {activeTab === "json" && (
            <JsonEditor
              key={editor.jsonEditorKey}
              value={state.manifest}
              onApply={(manifest) => {
                editor.replaceManifest(manifest);
                setActiveTab("general");
              }}
              schema={schema}
            />
          )}
          <PackageFilesEditor
            packageId={packageId}
            type={type}
            active={activeTab === "files"}
            operations={state.operations ?? []}
            onChange={(operations) => setState((current) => ({ ...current, operations }))}
            manifest={state.manifest}
            disabled={isPending}
            onBusyChange={editor.setPreparingFiles}
          />
        </>
      )}

      <UnsavedChangesModal
        blocker={editor.blocker}
        onSaveDraft={isEdit ? editor.saveDraft : undefined}
      />
    </div>
  );

  if (isEdit) {
    // Only when there is something to save, as the files explorer's bar is.
    const footer = (editor.isDirty || isPending) && (
      <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
        <span className="text-muted-foreground text-sm">
          {t("unsaved.title", { ns: "common" })}
        </span>
        <div className="ml-auto flex items-center gap-2 max-lg:ml-0 max-lg:w-full">
          <Button
            variant="outline"
            type="button"
            onClick={editor.discard}
            disabled={isPending}
            className="max-lg:flex-1"
          >
            {t("editor.discardChanges")}
          </Button>
          <PendingButton
            type="button"
            onClick={editor.submit}
            pending={isPending}
            className="max-lg:flex-1"
          >
            {t("btn.save")}
          </PendingButton>
        </div>
      </div>
    );
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex-1 space-y-4 p-6">
          <SettingsHeading
            title={tabs.find((tab) => tab.id === activeTab)?.label}
            description={descriptions?.[activeTab]}
          />
          {editor.error && (
            <Alert variant="destructive">
              <AlertDescription>{editor.error}</AlertDescription>
            </Alert>
          )}
          {body}
        </div>
        {footer}
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

      {editor.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{editor.error}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === "json") editor.bumpJsonKey();
          setActiveTab(v as PackageEditorTab);
        }}
        className="mb-4"
      >
        <TabsList className="overflow-x-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {body}

      {activeTab !== "json" && (
        <div className="border-border mt-6 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" type="button" onClick={() => navigate(listPath)}>
            {t("btn.cancel")}
          </Button>
          <PendingButton type="button" onClick={editor.submit} pending={isPending}>
            {t("btn.create")}
          </PendingButton>
        </div>
      )}
    </div>
  );
}
