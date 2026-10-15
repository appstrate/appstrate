// SPDX-License-Identifier: Apache-2.0

/**
 * The file gestures of a package draft: new file, import, replace, rename,
 * delete. Each one only stages an operation (`lib/package-file-drafts`); the
 * caller's Save sends them. Naming a file and deleting one are dialogs this hook mounts.
 */
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { formatBytes } from "../../lib/format-bytes";
import { packageFilesErrorKey } from "../../lib/package-files";
import {
  fileTextOperation,
  importRefusal,
  projectDraftFiles,
  stageFileOperations,
  uploadedFileOperation,
} from "../../lib/package-file-drafts";
import type { PackageFileEntry, PackageFileWriteOperation } from "../../lib/package-file-tree";
import { ConfirmModal } from "../confirm-modal";
import { FilePathDialog } from "./file-path-dialog";

interface Options {
  type: PackageType;
  /** The tree the staged operations apply to; undefined until it has loaded. */
  base: readonly PackageFileEntry[] | undefined;
  /** The draft's tree as shown: a new path must fit into it. */
  entries: readonly PackageFileEntry[];
  operations: readonly PackageFileWriteOperation[];
  onChange: (operations: PackageFileWriteOperation[]) => void;
  /** The file a gesture created, renamed or imported. */
  onSelect: (path: string) => void;
  /** Another write is in flight. */
  disabled: boolean;
}

export function useStagedPackageFiles({
  type,
  base,
  entries,
  operations,
  onChange,
  onSelect,
  disabled,
}: Options) {
  const { t } = useTranslation(["agents", "common"]);
  const [naming, setNaming] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Counts imports, so an editor open on a replaced file remounts on its new bytes.
  const [imports, setImports] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const limit = formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES);
  const busy = disabled || uploading;

  /** Stages `added` when the projected tree accepts it; refusals are toasted. */
  const stage = (added: PackageFileWriteOperation[], select?: string): boolean => {
    if (!base) return false;
    try {
      const next = stageFileOperations(operations, added);
      projectDraftFiles(base, next, type);
      onChange(next);
      if (select !== undefined) onSelect(select);
      setDeleting(null);
      setNaming(false);
      setRenaming(null);
      return true;
    } catch (error) {
      toast.error(t(packageFilesErrorKey(error) ?? "files.errorGeneric", { limit }));
      return false;
    }
  };

  /** Opens the file picker: one file replacing `target`, or new files when null. */
  const pickUpload = (target: string | null) => {
    replaceTarget.current = target;
    if (uploadRef.current) {
      uploadRef.current.multiple = target === null;
      uploadRef.current.click();
    }
  };

  const upload = async (files: File[]) => {
    const target = replaceTarget.current;
    const refusal = importRefusal(entries, files, target !== null);
    if (refusal) {
      toast.error(t(refusal.key, { limit, path: refusal.path }));
      return;
    }
    setUploading(true);
    try {
      const added = await Promise.all(
        files.map((file) => uploadedFileOperation(target ?? file.name, file)),
      );
      setImports((value) => value + 1);
      stage(added, added[0]?.op === "write" ? added[0].path : undefined);
    } catch {
      toast.error(t("files.errorGeneric"));
    } finally {
      setUploading(false);
    }
  };

  const dialogs: ReactNode = (
    <>
      <input
        ref={uploadRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      {naming && (
        <FilePathDialog
          title={t("files.newFile")}
          confirmLabel={t("btn.create", { ns: "common" })}
          initialPath=""
          entries={entries}
          onClose={() => setNaming(false)}
          onSubmit={(path) => stage([fileTextOperation(path, "")], path)}
        />
      )}
      {renaming !== null && (
        <FilePathDialog
          title={t("files.newName")}
          confirmLabel={t("files.rename")}
          initialPath={renaming}
          entries={entries.filter((entry) => entry.path !== renaming)}
          onClose={() => setRenaming(null)}
          onSubmit={(to) => stage([{ op: "move", from: renaming, to }], to)}
        />
      )}
      {deleting !== null && (
        <ConfirmModal
          open
          onClose={() => setDeleting(null)}
          title={t("files.delete")}
          description={t("files.deleteConfirm", { path: deleting })}
          confirmLabel={t("files.delete")}
          isPending={busy}
          onConfirm={() => stage([{ op: "delete", path: deleting }])}
        />
      )}
    </>
  );

  return {
    busy,
    imports,
    stage,
    pickUpload,
    openNewFile: () => setNaming(true),
    openRename: (path: string) => setRenaming(path),
    openDelete: (path: string) => setDeleting(path),
    /** The hidden file input and the gestures' dialogs; render it once. */
    dialogs,
  };
}
