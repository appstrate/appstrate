// SPDX-License-Identifier: Apache-2.0

import { useState, useMemo, useCallback, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { PACKAGE_CONFIG } from "./use-packages";
import type { PackageType } from "@appstrate/shared-types";
import { useCreatePackage, useUpdatePackage } from "./use-mutations";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useUnsavedChanges } from "./use-unsaved-changes";
import { agentsKeys, packageKeys } from "../lib/query-keys";

/**
 * Minimal shape every package editor state must satisfy. The hook
 * compares snapshots via JSON.stringify and ships these fields to
 * the API; per-editor state may carry extra fields freely.
 */
export interface EditorStateBase {
  manifest: Record<string, unknown>;
  lock_version?: number;
}

interface UseEditorStateOptions<S extends EditorStateBase> {
  initialState: S;
  packageType: Exclude<PackageType, "mcp-server">;
  packageId: string | undefined;
  isEdit: boolean;
  /**
   * Build the wire body (manifest + content + …) sent to
   * `POST /packages/:type` on create and to `PUT /packages/:type/:id`
   * on update. `lock_version` is appended automatically by the hook
   * for updates and draft saves — do not include it here.
   */
  toWireBody: (state: S) => Record<string, unknown>;
  /** The message the author reads, or `null` to keep the server's English `detail`. */
  translateError?: (err: Error) => string | null;
  /**
   * Pre-submit validation hook. Return an error message + the tab to
   * focus, or `null` to proceed. Runs before the API call so we can
   * surface inline errors without hitting the server.
   */
  validate?: (state: S) => { error: string; tab?: string } | null;
  /**
   * Dirtiness the state snapshot cannot see — the skill editor's buffered file
   * edits, which live outside `state` because their owner writes them through a
   * route of its own. ORed into {@link UseEditorStateReturn.isDirty} so one
   * unsaved-changes blocker still covers the whole editor.
   */
  extraDirty?: boolean;
  /**
   * Sent before the update request on an EXISTING package, in both save paths.
   * Returns the `lock_version` its own writes left on the row, or `undefined`
   * when it wrote nothing — the `PUT` then carries whichever token is current,
   * so a write through another route cannot make the manifest save `409`.
   */
  beforeUpdate?: () => Promise<number | undefined>;
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
}

/**
 * The author-owned half of an editor's state.
 *
 * `lock_version` is the row's optimistic token, handed back by the server on
 * every write — never something the author typed. Comparing it would report the
 * editor dirty the moment anything bumps it: a saved draft, or one of the skill
 * editor's immediate file operations, each of which leaves nothing unsaved and
 * would still raise the leave-this-page blocker.
 */
function authoredFields<S extends EditorStateBase>(state: S): Omit<S, "lock_version"> {
  const { lock_version: _token, ...authored } = state;
  return authored;
}

/**
 * Shared form-state machinery for package editors (agent/skill).
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
  const {
    initialState,
    packageType,
    packageId,
    isEdit,
    toWireBody,
    validate,
    translateError,
    extraDirty = false,
    beforeUpdate,
  } = opts;
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
  // `beforeUpdate` runs outside React Query, so the save bar would otherwise
  // look idle for the whole flush.
  const [isFlushing, setIsFlushing] = useState(false);

  const updateManifest = useCallback(
    (patch: Record<string, unknown>) =>
      setState((s) => ({ ...s, manifest: { ...s.manifest, ...patch } })),
    [],
  );

  const isDirty = useMemo(
    () =>
      extraDirty ||
      JSON.stringify(authoredFields(initialSnapshot)) !== JSON.stringify(authoredFields(state)),
    [extraDirty, initialSnapshot, state],
  );

  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const bumpJsonKey = useCallback(() => setJsonEditorKey((k) => k + 1), []);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    // Same pre-submit `validate` as `handleSubmit`: this path bypassed it, so
    // a rule the submit button enforced could be walked around from the modal.
    const invalid = validate?.(state);
    if (invalid) {
      setError(invalid.error);
      throw new Error(invalid.error);
    }
    const cfg = PACKAGE_CONFIG[packageType];
    setIsFlushing(true);
    let lockVersion: number;
    try {
      lockVersion = (await beforeUpdate?.()) ?? state.lock_version!;
    } finally {
      setIsFlushing(false);
    }
    // PUT returns the updated package resource bare (issue #657) — read back
    // the NEW `lock_version` so a subsequent save doesn't go stale.
    const { data: updated } = await client.PUT(`/api/packages/${cfg.path}/{scope}/{name}`, {
      params: { path: splitPackageRef(packageId) },
      // `toWireBody` returns a `Record<string, unknown>`, so the spread body's
      // `manifest`/`content` keys aren't statically known. Assert the wire
      // shape the editor produces; `content` is optional because a manifest-only
      // save is a real one — the skill editor authors its files through
      // `PATCH .../files`, and the route carries the stored draft forward.
      body: {
        ...toWireBody(state),
        lock_version: lockVersion,
      } as { manifest: Record<string, unknown>; content?: string; lock_version: number },
    });
    setState((s) => ({ ...s, lock_version: updated!.lock_version ?? 0 }));
    qc.invalidateQueries({ queryKey: packageKeys.all });
    qc.invalidateQueries({ queryKey: ["version-info"] });
    if (packageType === "agent") {
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      // Tools → required scopes → per-integration agent-resolution verdict.
      // Refresh the integrations subtree so the Connections tab reflects a
      // newly-required reconnection/upgrade without a page reload.
      void invalidateIntegrationQueries(qc);
    }
  }, [state, isEdit, packageId, packageType, qc, toWireBody, validate, beforeUpdate]);

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

      const body = toWireBody(state);
      if (isEdit) {
        // Unlike saveDraft, this path does NOT read back the response's
        // lock_version: useUpdatePackage.onSuccess navigates away and the
        // editor unmounts, so the stale token can never be reused. If that
        // navigation is ever removed, read the token back here too or the
        // next save will 409.
        setIsFlushing(true);
        void (async () => {
          let lockVersion: number;
          try {
            lockVersion = (await beforeUpdate?.()) ?? state.lock_version!;
          } catch (err) {
            setError(translateError?.(err as Error) ?? (err as Error).message);
            return;
          } finally {
            setIsFlushing(false);
          }
          // The blocker opens here and not a line earlier: everything above can
          // fail with the author's work still in the page — the flush writes the
          // files through a route of its own — and a save that fails must leave
          // the leave-this-page guard exactly as it found it. Same for the
          // request itself, which is why `onError` closes it again.
          allowNavigation();
          updatePkg.mutate(
            {
              ...(body as Parameters<typeof updatePkg.mutate>[0]),
              lock_version: lockVersion,
            },
            {
              onError: (err) => {
                allowNavigation(false);
                setError(translateError?.(err) ?? err.message);
              },
            },
          );
        })();
      } else {
        allowNavigation();
        createPkg.mutate(body as Parameters<typeof createPkg.mutate>[0], {
          onError: (err) => {
            allowNavigation(false);
            setError(translateError?.(err) ?? err.message);
          },
        });
      }
    },
    [
      state,
      isEdit,
      validate,
      allowNavigation,
      toWireBody,
      createPkg,
      updatePkg,
      translateError,
      beforeUpdate,
    ],
  );

  const isPending = createPkg.isPending || updatePkg.isPending || isFlushing;

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
