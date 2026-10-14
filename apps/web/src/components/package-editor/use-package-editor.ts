// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useEditorState, type EditorState } from "../../hooks/use-editor-state";
import type { EditablePackageType } from "../editor-shell";
import type { MetadataState } from "../agent-editor/metadata-section";
import {
  getManifestName,
  manifestToMetadata,
  metadataToManifestPatch,
} from "../agent-editor/utils";

export type PackageEditorTab =
  | "general"
  | "schema"
  | "skills"
  | "integrations"
  | "source"
  | "auths"
  | "tools"
  | "files"
  | "json";

/**
 * Two presentations of one editor.
 *
 * `page` creates a package: every tab, the files included, on the creation
 * route. `embedded` edits an existing one inside its Paramètres › Package AFPS,
 * one rail section at a time — and there it edits the MANIFEST only. The
 * package's files are changed in Explorer › Fichiers, where the tree is; the
 * Package AFPS › Contenu table only reads them.
 *
 * So the presentation IS the create/edit distinction: `embedded` is what the
 * shared editor pieces call `isEdit`, and only `page` draws a Cancel.
 */
export type Presentation = "page" | "embedded";

type ValidationError = { error: string; tab?: string } | null;

/**
 * Save from a package's Package AFPS. It saves the draft IN PLACE (no redirect:
 * the reader is already on the package) and reads back the draft's new ETag;
 * the parent refetches the package and remounts the editor on it, which is
 * what clears the unsaved state.
 */
async function saveEmbedded(saveDraft: () => Promise<void>, savedMessage: string) {
  try {
    await saveDraft();
    toast.success(savedMessage);
  } catch {
    // `saveDraft` has already said why, translated, in the editor's error slot.
  }
}

/** The open section: the settings rail's when it names one (embedded), else the editor's own. */
function useEditorTab(
  tab: PackageEditorTab | undefined,
  onTabRequest: ((tab: PackageEditorTab) => void) | undefined,
) {
  const [localTab, setLocalTab] = useState<PackageEditorTab>("general");
  const setActiveTab = (next: PackageEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);
  return [tab ?? localTab, setActiveTab] as const;
}

/**
 * The editor state every package type shares: the draft, the open section,
 * the identity form, save and discard. A type adds its own rules to the one
 * they all have (an id), and its own sections.
 */
export function usePackageEditor({
  type,
  initialState,
  packageId,
  presentation,
  tab,
  onTabRequest,
  validate,
  onManifestReplace,
}: {
  type: EditablePackageType;
  initialState: EditorState;
  packageId: string | undefined;
  presentation: Presentation;
  /** Embedded: the section is the settings rail's, not the editor's. */
  tab?: PackageEditorTab;
  onTabRequest?: (tab: PackageEditorTab) => void;
  validate?: (state: EditorState) => ValidationError;
  /** The manifest was replaced whole (discard, raw JSON): for state an editor keeps beside it. */
  onManifestReplace?: (manifest: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [activeTab, setActiveTab] = useEditorTab(tab, onTabRequest);
  const embedded = presentation === "embedded";

  const editor = useEditorState({
    initialState,
    packageType: type,
    packageId,
    isEdit: embedded,
    validate: (s) =>
      getManifestName(s.manifest).id
        ? (validate?.(s) ?? null)
        : { error: t("editor.errorRequired"), tab: "general" },
  });
  const { state, setState, updateManifest, setError, bumpJsonKey, saveDraft, handleSubmit } =
    editor;

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

  const submit = () =>
    embedded
      ? void saveEmbedded(saveDraft, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as PackageEditorTab));

  return {
    ...editor,
    type,
    packageId,
    presentation,
    embedded,
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
