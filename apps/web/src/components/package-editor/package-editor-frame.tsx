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
import { JsonEditor } from "../json-editor";
import { PackageFilesEditor } from "../package-files/package-files-editor";
import { ManifestEditEntry } from "../package-files/package-files-section";
import { DetailBar } from "../detail-bar";
import { DetailTabs } from "../detail-tabs";
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
  /** `createOnly` tabs show on the creation page only; editing is the settings rail's. */
  tabs: Array<{ id: PackageEditorTab; label: string; createOnly?: boolean }>;
  /** Editing: the line under the open section's heading. */
  descriptions?: Partial<Record<PackageEditorTab, string>>;
  children: ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const navigate = useNavigate();
  const { type, packageId, isEdit, state, setState, activeTab, setActiveTab, isPending } = editor;
  const visibleTabs = tabs.filter((tab) => !tab.createOnly || !isEdit);
  const schema = { uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] };

  const body = (
    <div
      inert={isPending}
      aria-busy={isPending}
      className={isEdit ? "flex flex-col gap-4" : undefined}
    >
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
        <div className="flex flex-1 flex-col gap-4 p-6">
          <SettingsHeading
            title={visibleTabs.find((tab) => tab.id === activeTab)?.label}
            description={descriptions?.[activeTab]}
            className="mb-2"
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
    // The tabs root wraps the page, header included: the tab bar is portalled
    // into the shell header and must still answer these tabs.
    <DetailTabs
      value={activeTab}
      onChange={(next) => {
        if (next === "json") editor.bumpJsonKey();
        setActiveTab(next);
      }}
    >
      <DetailBar
        title={t(page.title)}
        parent={{ label: t(page.list.key, { ns: page.list.ns }), href: listPath }}
        tabs={visibleTabs.map(({ id, label }) => ({ value: id, label }))}
      />

      <div className="flex flex-col gap-4">
        {editor.error && (
          <Alert variant="destructive">
            <AlertDescription>{editor.error}</AlertDescription>
          </Alert>
        )}

        {body}

        {activeTab !== "json" && (
          <div className="border-border mt-2 flex justify-end gap-2 border-t pt-4">
            <Button variant="outline" type="button" onClick={() => navigate(listPath)}>
              {t("btn.cancel")}
            </Button>
            <PendingButton type="button" onClick={editor.submit} pending={isPending}>
              {t("btn.create")}
            </PendingButton>
          </div>
        )}
      </div>
    </DetailTabs>
  );
}
