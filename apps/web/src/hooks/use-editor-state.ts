// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "@appstrate/core/format";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { packageFilesErrorKey } from "../lib/package-files";
import { useNavigate } from "react-router-dom";
import type { PackageType } from "@appstrate/core/validation";
import { useCreatePackage, useUpdatePackage } from "./use-mutations";
import { useUnsavedChanges } from "./use-unsaved-changes";
import { packageDetailPath } from "../lib/package-paths";
import { packageUpdateBody } from "../lib/package-file-drafts";
import type { PackageFileWriteOperation } from "../lib/package-file-tree";

export interface EditorStateBase {
  manifest: Record<string, unknown>;
  lock_version?: number;
  operations?: PackageFileWriteOperation[];
}

interface UseEditorStateOptions<S extends EditorStateBase> {
  initialState: S;
  packageType: PackageType;
  packageId: string | undefined;
  isEdit: boolean;
  /** Create payload only. Existing drafts use the common manifest/operations contract. */
  toWireBody: (state: S) => Record<string, unknown>;
  translateError?: (error: Error) => string | null;
  validate?: (state: S) => { error: string; tab?: string } | null;
}

interface UseEditorStateReturn<S extends EditorStateBase> {
  state: S;
  setState: React.Dispatch<React.SetStateAction<S>>;
  /** Shallow-merge a patch into `state.manifest`. */
  updateManifest: (patch: Record<string, unknown>) => void;
  isDirty: boolean;
  blocker: ReturnType<typeof useUnsavedChanges>["blocker"];
  allowNavigation: (allowed?: boolean) => void;
  error: string | null;
  setError: (err: string | null) => void;
  jsonEditorKey: number;
  bumpJsonKey: () => void;
  saveDraft: () => Promise<void>;
  handleSubmit: (
    e?: FormEvent,
    /** Called when `validate` reports an error so the caller can focus the right tab. */
    onValidationError?: (tab: string | undefined) => void,
  ) => void;
  isPending: boolean;
  setPreparingFiles: (busy: boolean) => void;
}

export function useEditorState<S extends EditorStateBase>({
  initialState,
  packageType,
  packageId,
  isEdit,
  toWireBody,
  translateError,
  validate,
}: UseEditorStateOptions<S>): UseEditorStateReturn<S> {
  const navigate = useNavigate();
  const { t } = useTranslation("agents");
  const [state, setState] = useState(initialState);
  const [initialSnapshot, setInitialSnapshot] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [jsonEditorKey, setJsonEditorKey] = useState(0);
  const [preparingFiles, setPreparingFiles] = useState(false);
  const saving = useRef(false);
  const createPkg = useCreatePackage(packageType);
  const updatePkg = useUpdatePackage(packageType, packageId ?? "");
  const isDirty = preparingFiles || JSON.stringify(state) !== JSON.stringify(initialSnapshot);
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);
  const updateManifest = useCallback(
    (patch: Record<string, unknown>) =>
      setState((current) => ({ ...current, manifest: { ...current.manifest, ...patch } })),
    [],
  );
  const bumpJsonKey = useCallback(() => setJsonEditorKey((key) => key + 1), []);

  const saveDraft = async () => {
    if (!isEdit || !packageId) return;
    if (saving.current || preparingFiles)
      throw new Error("An editor operation is still in progress");
    const invalid = validate?.(state);
    if (invalid) {
      setError(invalid.error);
      throw new Error(invalid.error);
    }
    saving.current = true;
    setError(null);
    try {
      const updated = await updatePkg.mutateAsync(packageUpdateBody(state));
      const saved = { ...state, operations: undefined, lock_version: updated.lock_version };
      setState(saved);
      setInitialSnapshot(saved);
    } catch (cause) {
      const failure = cause as Error;
      const key = packageFilesErrorKey(failure);
      setError(
        key
          ? t(key, { limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES) })
          : (translateError?.(failure) ?? failure.message),
      );
      throw cause;
    } finally {
      saving.current = false;
    }
  };

  const handleSubmit = (
    event?: FormEvent,
    onValidationError?: (tab: string | undefined) => void,
  ) => {
    event?.preventDefault();
    const invalid = validate?.(state);
    if (invalid) {
      setError(invalid.error);
      onValidationError?.(invalid.tab);
      return;
    }
    if (isEdit) {
      void saveDraft().then(
        () => {
          allowNavigation();
          navigate(packageDetailPath(packageType, packageId!));
        },
        () => {},
      );
    } else {
      allowNavigation();
      createPkg.mutate(toWireBody(state) as Parameters<typeof createPkg.mutate>[0], {
        onError: (failure) => {
          allowNavigation(false);
          setError(translateError?.(failure) ?? failure.message);
        },
      });
    }
  };
  return {
    state,
    setState,
    updateManifest,
    isDirty,
    blocker,
    allowNavigation,
    error,
    setError,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    setPreparingFiles,
    isPending: preparingFiles || createPkg.isPending || updatePkg.isPending,
  };
}
