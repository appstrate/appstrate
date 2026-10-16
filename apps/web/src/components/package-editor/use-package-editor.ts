// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useEditorState, type EditorState } from "../../hooks/use-editor-state";
import type { EditablePackageType } from "./package-editor-frame";
import type { MetadataState } from "../agent-editor/metadata-section";
import {
  getManifestName,
  manifestToMetadata,
  metadataToManifestPatch,
} from "../agent-editor/utils";

export type PackageEditorTab =
  "general" | "schema" | "skills" | "integrations" | "source" | "auths" | "tools";

type ValidationError = { error: string; tab?: string } | null;

/** Saves the draft in place; the parent then refetches and remounts the editor, which clears the unsaved state. */
async function saveEdit(saveDraft: () => Promise<void>, savedMessage: string) {
  try {
    await saveDraft();
    toast.success(savedMessage);
  } catch {
    // `saveDraft` has already said why, translated, in the editor's error slot.
  }
}

/** The open section: the settings rail's when it names one (editing), else the editor's own. */
function useEditorTab(
  tab: PackageEditorTab | undefined,
  onTabRequest: ((tab: PackageEditorTab) => void) | undefined,
) {
  const [localTab, setLocalTab] = useState<PackageEditorTab>("general");
  const setActiveTab = (next: PackageEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);
  return [tab ?? localTab, setActiveTab] as const;
}

/** Definition draft, open section and save/discard, shared by existing package editors. */
export function usePackageEditor({
  type,
  initialState,
  packageId,
  tab,
  onTabRequest,
  validate,
  onManifestReplace,
}: {
  type: EditablePackageType;
  initialState: EditorState;
  packageId: string;
  /** Editing: the section is the settings rail's, not the editor's. */
  tab?: PackageEditorTab;
  onTabRequest?: (tab: PackageEditorTab) => void;
  validate?: (state: EditorState) => ValidationError;
  /** The manifest was replaced whole (discard, raw JSON): for state an editor keeps beside it. */
  onManifestReplace?: (manifest: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [activeTab, setActiveTab] = useEditorTab(tab, onTabRequest);
  const isEdit = packageId !== undefined;

  const editor = useEditorState({
    initialState,
    packageType: type,
    packageId,
    isEdit,
    validate: (s) =>
      getManifestName(s.manifest).id
        ? (validate?.(s) ?? null)
        : { error: t("editor.errorRequired"), tab: "general" },
  });
  const { state, setState, updateManifest, setError, bumpJsonKey, saveDraft } = editor;

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const replaceManifest = (manifest: Record<string, unknown>) => {
    setState((s) => ({ ...s, manifest }));
    onManifestReplace?.(manifest);
  };

  const discard = () => {
    setState(initialState);
    onManifestReplace?.(initialState.manifest);
    setError(null);
    bumpJsonKey();
  };

  const submit = () => void saveEdit(saveDraft, t("editor.saved"));

  return {
    ...editor,
    type,
    packageId,
    isEdit,
    activeTab,
    setActiveTab,
    metadata,
    onMetadataChange,
    replaceManifest,
    discard,
    submit,
  };
}

export type PackageEditor = ReturnType<typeof usePackageEditor>;
