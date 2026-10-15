// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
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

type ValidationError = { error: string } | null;

/**
 * The editor state every package type shares: draft, identity form, save and discard. It edits an
 * existing package inside its settings (Package AFPS), the MANIFEST only: files are changed in
 * Explorer › Fichiers, and a package is created from `CreatePackageModal`.
 */
export function usePackageEditor({
  type,
  initialState,
  packageId,
  tab,
  validate,
  onManifestReplace,
}: {
  type: EditablePackageType;
  initialState: EditorState;
  packageId: string;
  /** The section is the settings rail's, not the editor's. */
  tab: PackageEditorTab;
  validate?: (state: EditorState) => ValidationError;
  /** The manifest was replaced whole (discard, raw JSON): for state an editor keeps beside it. */
  onManifestReplace?: (manifest: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);

  const editor = useEditorState({
    initialState,
    packageType: type,
    packageId,
    validate: (s) =>
      getManifestName(s.manifest).id
        ? (validate?.(s) ?? null)
        : { error: t("editor.errorRequired") },
  });
  const { state, setState, updateManifest, setError, saveDraft } = editor;

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
  };

  /** Saves the draft in place; the parent then refetches and remounts the editor, which clears the unsaved state. */
  const submit = async () => {
    try {
      await saveDraft();
      toast.success(t("editor.saved"));
    } catch {
      // `saveDraft` has already said why, translated, in the editor's error slot.
    }
  };

  return {
    ...editor,
    type,
    packageId,
    activeTab: tab,
    metadata,
    onMetadataChange,
    replaceManifest,
    discard,
    submit,
  };
}

export type PackageEditor = ReturnType<typeof usePackageEditor>;
