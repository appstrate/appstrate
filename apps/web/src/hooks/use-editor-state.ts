// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, useCallback, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { PACKAGE_CONFIG } from "./use-packages";
import type { PackageType } from "@appstrate/shared-types";
import { useCreatePackage, useUpdatePackage } from "./use-mutations";
import { useUnsavedChanges } from "./use-unsaved-changes";

/**
 * Minimal shape every package editor state must satisfy. The hook
 * compares snapshots via JSON.stringify and ships these fields to
 * the API; per-editor state may carry extra fields freely.
 */
export interface EditorStateBase {
  manifest: Record<string, unknown>;
  lockVersion?: number;
}

export interface UseEditorStateOptions<S extends EditorStateBase> {
  initialState: S;
  packageType: PackageType;
  packageId: string | undefined;
  isEdit: boolean;
  /**
   * Build the wire body (manifest + content + sourceCode + …) sent to
   * `POST /packages/:type` on create and to `PUT /packages/:type/:id`
   * on update. `lockVersion` is appended automatically by the hook
   * for updates and draft saves — do not include it here.
   */
  toWireBody: (state: S) => Record<string, unknown>;
  /**
   * Pre-submit validation hook. Return an error message + the tab to
   * focus, or `null` to proceed. Runs before the API call so we can
   * surface inline errors without hitting the server.
   */
  validate?: (state: S) => { error: string; tab?: string } | null;
}

export interface UseEditorStateReturn<S extends EditorStateBase> {
  state: S;
  setState: React.Dispatch<React.SetStateAction<S>>;
  /** Shallow-merge a patch into `state.manifest`. */
  updateManifest: (patch: Record<string, unknown>) => void;
  isDirty: boolean;
  blocker: ReturnType<typeof useUnsavedChanges>["blocker"];
  allowNavigation: () => void;
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
}

/**
 * Shared form-state machinery for package editors (agent/skill/tool/provider).
 *
 * Owns: state snapshot, dirty detection, unsaved-changes blocker, error,
 * jsonEditorKey, draft save, and create/update submission. Editor-specific
 * fields (schemaFields, credentialFields, activeTab…) stay in the
 * components — this hook is intentionally thin so 5-tab editors can layer
 * their own state without fighting the abstraction.
 */
export function useEditorState<S extends EditorStateBase>(
  opts: UseEditorStateOptions<S>,
): UseEditorStateReturn<S> {
  const { initialState, packageType, packageId, isEdit, toWireBody, validate } = opts;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createPkg = useCreatePackage(packageType);
  const updatePkg = useUpdatePackage(packageType, packageId || "");

  // Snapshot the initial state once so `isDirty` compares against the
  // exact bytes the editor mounted with — a re-render caused by a parent
  // shouldn't reset dirtiness.
  const [initialSnapshot] = useState(initialState);
  const [state, setState] = useState<S>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [jsonEditorKey, setJsonEditorKey] = useState(0);

  const updateManifest = useCallback(
    (patch: Record<string, unknown>) =>
      setState((s) => ({ ...s, manifest: { ...s.manifest, ...patch } })),
    [],
  );

  const isDirty = useMemo(
    () => JSON.stringify(initialSnapshot) !== JSON.stringify(state),
    [initialSnapshot, state],
  );

  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const bumpJsonKey = useCallback(() => setJsonEditorKey((k) => k + 1), []);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    const cfg = PACKAGE_CONFIG[packageType];
    await api(`/packages/${cfg.path}/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({
        ...toWireBody(state),
        lockVersion: state.lockVersion!,
      }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
    if (packageType === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
    if (packageType === "provider") qc.invalidateQueries({ queryKey: ["providers"] });
  }, [state, isEdit, packageId, packageType, qc, toWireBody]);

  const handleSubmit = useCallback(
    (e?: FormEvent, onValidationError?: (tab: string | undefined) => void) => {
      e?.preventDefault();
      setError(null);

      if (validate) {
        const v = validate(state);
        if (v) {
          setError(v.error);
          onValidationError?.(v.tab);
          return;
        }
      }

      allowNavigation();
      const body = toWireBody(state);
      if (isEdit) {
        updatePkg.mutate(
          { ...(body as Parameters<typeof updatePkg.mutate>[0]), lockVersion: state.lockVersion! },
          { onError: (err) => setError(err.message) },
        );
      } else {
        createPkg.mutate(body as Parameters<typeof createPkg.mutate>[0], {
          onError: (err) => setError(err.message),
        });
      }
    },
    [state, isEdit, validate, allowNavigation, toWireBody, createPkg, updatePkg],
  );

  const isPending = createPkg.isPending || updatePkg.isPending;

  // navigate is unused in the public surface (callers handle their own
  // cancel routing) but we keep the import: future onCancel helper.
  void navigate;

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
    isPending,
  };
}
