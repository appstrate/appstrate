// SPDX-License-Identifier: Apache-2.0

/**
 * The file edits staged on a package's draft from its explorer: the operations, the tree they
 * project, and the one PUT that sends them with the stored manifest and its lock version.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { usePackageDetail } from "../../hooks/use-packages";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { useReportEditorDirty } from "../../hooks/use-editor-state";
import { formatBytes } from "../../lib/format-bytes";
import { errorMessage } from "../../lib/mutation-error";
import { invalidatePaths } from "../../lib/query-keys";
import { packageFilesErrorKey } from "../../lib/package-files";
import {
  packageUpdateBody,
  projectDraftFiles,
  type DraftFile,
} from "../../lib/package-file-drafts";
import type { PackageFileEntry, PackageFileWriteOperation } from "../../lib/package-file-tree";
import { useStagedPackageFiles } from "./use-staged-package-files";

export function useDraftFileEdits({
  type,
  packageId,
  index,
  editing,
  onSelect,
}: {
  type: PackageType;
  packageId: string;
  /** The tree as the server holds it; undefined until it has loaded. */
  index: readonly PackageFileEntry[] | undefined;
  /** The reader may write this package and is looking at its draft. */
  editing: boolean;
  /** The file a gesture created, renamed or imported. */
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const { data: writableDraft } = usePackageDetail(type, editing ? packageId : undefined);
  const updatePackage = useUpdatePackage(type, packageId);
  const [operations, setOperations] = useState<PackageFileWriteOperation[]>([]);
  // The draft the first edit started from. A refetch cannot rebase staged edits;
  // its ETag (sent as If-Match) rejects the save if the package moved meanwhile.
  const [base, setBase] = useState<{
    entries: readonly PackageFileEntry[];
    etag: string;
    manifest: Record<string, unknown>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = operations.length > 0;
  const { blocker } = useUnsavedChanges(dirty);
  useReportEditorDirty(dirty);

  const baseEntries = base?.entries ?? index;
  const entries: readonly DraftFile[] | undefined =
    editing && baseEntries ? projectDraftFiles(baseEntries, operations, type) : index;
  const staged = useStagedPackageFiles({
    type,
    base: baseEntries,
    entries: entries ?? [],
    operations,
    onChange: (next) => {
      if (base === null && baseEntries && writableDraft) {
        setBase({
          entries: baseEntries,
          etag: writableDraft.etag ?? "",
          manifest: writableDraft.manifest ?? {},
        });
      }
      setOperations(next);
      setSaveError(null);
    },
    onSelect,
    disabled: saving || !writableDraft,
  });

  const discard = () => {
    setOperations([]);
    setBase(null);
    setSaveError(null);
  };

  /** Rejects after recording the refusal, so a caller that must know it failed can tell. */
  const save = async () => {
    if (!base || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePackage.mutateAsync({
        etag: base.etag,
        body: packageUpdateBody({ manifest: base.manifest, operations }),
      });
      // Start again from what the server now holds, not from the staged tree.
      await invalidatePaths(queryClient, ["/api/packages/{scope}/{name}/files"], "all");
      discard();
      toast.success(t("files.saved"));
    } catch (error) {
      const key = packageFilesErrorKey(error);
      setSaveError(
        key ? t(key, { limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES) }) : errorMessage(error),
      );
      throw error;
    } finally {
      setSaving(false);
    }
  };

  return {
    entries,
    staged,
    operations,
    dirty,
    blocker,
    saveError,
    discard,
    /** Undefined until a first edit fixed the draft it will be sent against. */
    save: base ? save : undefined,
  };
}
