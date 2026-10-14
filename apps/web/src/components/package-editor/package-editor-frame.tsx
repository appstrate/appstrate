// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  agentSchema,
  skillSchema,
  integrationSchema,
  mcpServerSchema,
} from "@appstrate/core/schemas";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { EditorShell, type EditablePackageType } from "../editor-shell";
import { JsonEditor } from "../json-editor";
import { PackageFilesEditor } from "../package-files/package-files-editor";
import { ManifestEditEntry } from "../package-files/package-files-section";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import type { PackageEditor, PackageEditorTab } from "./use-package-editor";

const PACKAGE_SCHEMAS: Record<EditablePackageType, object> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
  "mcp-server": mcpServerSchema,
};

/**
 * What every package editor draws around its own sections: the shell, the raw
 * manifest (opened from `manifest.json` embedded, a tab on the page), the
 * files tab of the page, and the unsaved-changes guard.
 */
export function PackageEditorFrame({
  editor,
  tabs,
  descriptions,
  children,
}: {
  editor: PackageEditor;
  tabs: Array<{ id: PackageEditorTab; label: string }>;
  /** Embedded: the line under the open section's heading. */
  descriptions?: Partial<Record<PackageEditorTab, string>>;
  children: ReactNode;
}) {
  const { type, packageId, embedded, state, setState, activeTab, setActiveTab } = editor;
  const schema = { uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] };

  return (
    <EditorShell
      type={type}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") editor.bumpJsonKey();
        setActiveTab(v as PackageEditorTab);
      }}
      error={editor.error}
      isPending={editor.isPending}
      onSubmit={editor.submit}
      hideSubmitBar={!embedded && activeTab === "json"}
      presentation={editor.presentation}
      activeDescription={embedded ? descriptions?.[activeTab] : undefined}
      isDirty={editor.isDirty}
      onDiscardChanges={editor.discard}
    >
      {children}
      {embedded ? (
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
            disabled={editor.isPending}
            onBusyChange={editor.setPreparingFiles}
          />
        </>
      )}

      <UnsavedChangesModal
        blocker={editor.blocker}
        onSaveDraft={embedded ? editor.saveDraft : undefined}
      />
    </EditorShell>
  );
}
