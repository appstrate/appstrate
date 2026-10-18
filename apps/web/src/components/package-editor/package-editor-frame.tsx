// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
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
import { Button } from "@appstrate/ui/components/button";
import { ManifestEditEntry } from "../package-files/package-files-section";
import { SettingsHeading } from "../settings/settings-heading";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import type { PackageEditor, PackageEditorTab } from "./use-package-editor";

/** Every type is edited in its Package AFPS. */
export type EditablePackageType = "agent" | "skill" | "integration" | "mcp-server";

const PACKAGE_SCHEMAS: Record<EditablePackageType, object> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
  "mcp-server": mcpServerSchema,
};

/** What every package editor draws around its sections: the open section's heading, the raw manifest under it, the save bar when something changed, and the unsaved-changes guard. */
export function PackageEditorFrame({
  editor,
  tabs,
  descriptions,
  children,
}: {
  editor: PackageEditor;
  /** The sections, labelled as the settings rail labels them. */
  tabs: Array<{ id: PackageEditorTab; label: string }>;
  /** The line under the open section's heading. */
  descriptions?: Partial<Record<PackageEditorTab, string>>;
  children: ReactNode;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { type, state, activeTab, isPending } = editor;
  const schema = { uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] };

  // Only when there is something to save, as the files explorer's bar is.
  const footer = (editor.isDirty || isPending) && (
    <div className="bg-background border-border sticky bottom-0 z-10 flex min-h-16 items-center gap-3 border-t px-6 py-3 max-lg:flex-col max-lg:items-stretch">
      <span className="text-muted-foreground text-sm">{t("unsaved.title", { ns: "common" })}</span>
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
          title={tabs.find((tab) => tab.id === activeTab)?.label}
          description={descriptions?.[activeTab]}
          className="mb-2"
        />
        {editor.error && (
          <Alert variant="destructive">
            <AlertDescription>{editor.error}</AlertDescription>
          </Alert>
        )}
        <div inert={isPending} aria-busy={isPending} className="flex flex-col gap-4">
          {children}
          <ManifestEditEntry
            value={state.manifest}
            schema={schema}
            onApply={editor.replaceManifest}
          />
          <UnsavedChangesModal blocker={editor.blocker} onSaveDraft={editor.saveDraft} />
        </div>
      </div>
      {footer}
    </div>
  );
}
