// SPDX-License-Identifier: Apache-2.0

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../lib/format-bytes";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { packageFilesErrorKey } from "../lib/package-files";
import type { PackageType } from "@appstrate/core/validation";
import { useUpdatePackage } from "./use-mutations";
import { useUnsavedChanges } from "./use-unsaved-changes";
import { packageUpdateBody } from "../lib/package-file-drafts";
import { errorMessage } from "../lib/mutation-error";

export interface EditorState {
  manifest: Record<string, unknown>;
  /** The draft version this editor is based on: its detail's `ETag`. */
  etag?: string | null;
}

/**
 * Told by an editor whether it holds unsaved edits, so the page hosting it can
 * hold back what would act on the stored definition instead (publish, run).
 */
export const EditorDirtyReportContext = createContext<(dirty: boolean) => void>(() => {});

export function useReportEditorDirty(isDirty: boolean) {
  const report = useContext(EditorDirtyReportContext);
  useEffect(() => {
    report(isDirty);
    return () => report(false);
  }, [report, isDirty]);
}

interface UseEditorStateOptions {
  initialState: EditorState;
  packageType: PackageType;
  packageId: string;
  validate?: (state: EditorState) => { error: string } | null;
}

interface UseEditorStateReturn {
  state: EditorState;
  setState: React.Dispatch<React.SetStateAction<EditorState>>;
  /** Shallow-merge a patch into `state.manifest`. */
  updateManifest: (patch: Record<string, unknown>) => void;
  isDirty: boolean;
  blocker: ReturnType<typeof useUnsavedChanges>["blocker"];
  error: string | null;
  setError: (err: string | null) => void;
  saveDraft: () => Promise<void>;
  isPending: boolean;
}

export function useEditorState({
  initialState,
  packageType,
  packageId,
  validate,
}: UseEditorStateOptions): UseEditorStateReturn {
  const { t } = useTranslation("agents");
  const [state, setState] = useState(initialState);
  const [initialSnapshot, setInitialSnapshot] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const updatePkg = useUpdatePackage(packageType, packageId);
  const isDirty = JSON.stringify(state) !== JSON.stringify(initialSnapshot);
  const { blocker } = useUnsavedChanges(isDirty);
  useReportEditorDirty(isDirty);
  const updateManifest = useCallback(
    (patch: Record<string, unknown>) =>
      setState((current) => ({ ...current, manifest: { ...current.manifest, ...patch } })),
    [],
  );

  /** Saves the manifest; edits made while the request was in flight stay, and stay unsaved. */
  const saveDraft = async () => {
    if (saving.current) throw new Error("An editor operation is still in progress");
    const invalid = validate?.(state);
    if (invalid) {
      setError(invalid.error);
      throw new Error(invalid.error);
    }
    saving.current = true;
    setError(null);
    const sent = state;
    try {
      const updated = await updatePkg.mutateAsync({
        etag: sent.etag ?? "",
        body: packageUpdateBody(sent),
      });
      setState((current) => ({ ...current, etag: updated.etag }));
      setInitialSnapshot({ ...sent, etag: updated.etag });
    } catch (cause) {
      const failure = cause as Error;
      const key = packageFilesErrorKey(failure);
      setError(
        key ? t(key, { limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES) }) : errorMessage(failure),
      );
      throw cause;
    } finally {
      saving.current = false;
    }
  };

  return {
    state,
    setState,
    updateManifest,
    isDirty,
    blocker,
    error,
    setError,
    saveDraft,
    isPending: updatePkg.isPending,
  };
}
