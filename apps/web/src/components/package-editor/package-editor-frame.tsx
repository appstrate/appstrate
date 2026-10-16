// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  agentSchema,
  skillSchema,
  integrationSchema,
  mcpServerSchema,
} from "@appstrate/core/schemas";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { ManifestEditEntry } from "../package-files/package-files-section";
import { SettingsHeading } from "../settings/settings-heading";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { SaveBar } from "../save-bar";
import type { PackageEditor, PackageEditorTab } from "./use-package-editor";

export type EditablePackageType = "agent" | "skill" | "integration" | "mcp-server";

const PACKAGE_SCHEMAS: Record<EditablePackageType, object> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
  "mcp-server": mcpServerSchema,
};

/** Definition edits share their save bar, raw manifest and unsaved-changes guard. */
export function PackageEditorFrame({
  editor,
  tabs,
  descriptions,
  children,
}: {
  editor: PackageEditor;
  tabs: Array<{ id: PackageEditorTab; label: string }>;
  descriptions?: Partial<Record<PackageEditorTab, string>>;
  children: ReactNode;
}) {
  const { t } = useTranslation("common");
  const { type, state, activeTab, isPending } = editor;
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-4 p-6" inert={isPending} aria-busy={isPending}>
        <SettingsHeading
          title={tabs.find((tab) => tab.id === activeTab)?.label}
          description={descriptions?.[activeTab]}
          className="mb-2"
        />
        {editor.error && (
          <Alert variant="destructive">
            <AlertDescription>{editor.error}</AlertDescription>
          </Alert>
        )}
        {children}
        <ManifestEditEntry
          value={state.manifest}
          schema={{ uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] }}
          onApply={editor.replaceManifest}
        />
      </div>
      <UnsavedChangesModal blocker={editor.blocker} onSaveDraft={editor.saveDraft} />
      {(editor.isDirty || isPending) && (
        <SaveBar
          message={t("unsaved.title")}
          pending={isPending}
          onDiscard={editor.discard}
          onSave={editor.submit}
        />
      )}
    </div>
  );
}
