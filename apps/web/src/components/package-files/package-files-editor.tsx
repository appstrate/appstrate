// SPDX-License-Identifier: Apache-2.0

import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@appstrate/ui/components/button";
import {
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
} from "@appstrate/core/package-files";
import { formatBytes } from "@appstrate/core/format";
import type { PackageType } from "@appstrate/core/validation";
import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { primaryDisplayFile, packageFilesErrorKey } from "../../lib/package-files";
import {
  projectDraftFiles,
  stageFileOperations,
  fileTextOperation,
  uploadedFileOperation,
  type DraftFile,
} from "../../lib/package-file-drafts";
import {
  isPinnedEntry,
  languageForPath,
  pickActiveEntry,
  previewBlockReason,
  validateNewPath,
  NEW_PATH_ERROR_KEYS,
  type PackageFileEntry,
  type PackageFileWriteOperation,
} from "../../lib/package-file-tree";
import { ConfirmModal } from "../confirm-modal";
import { ContentEditor } from "../package-editor/content-editor";
import { LoadingState, ErrorState } from "../page-states";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { FilePathDialog } from "./file-path-dialog";
import { usePackageFile } from "./use-package-file";

type Dialog = { kind: "create" } | { kind: "rename" | "delete"; path: string } | null;

interface Props {
  packageId: string;
  type: PackageType;
  active: boolean;
  operations: readonly PackageFileWriteOperation[];
  onChange: (operations: PackageFileWriteOperation[]) => void;
  manifest: Record<string, unknown>;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}

/** All edits stay in the package draft; only the parent's Save writes them. */
export function PackageFilesEditor({
  packageId,
  type,
  active,
  operations,
  onChange,
  manifest,
  disabled,
  onBusyChange,
}: Props) {
  const { t } = useTranslation(["agents", "common"]);
  const scope = useOrgScope();
  const query = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: { path: splitPackageRef(packageId), header: scope.header },
    },
    { enabled: scope.enabled, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  );
  // Keep the tree this draft started from. Refetches cannot silently rebase it;
  // the parent's original lock_version rejects any intervening server write.
  const [base, setBase] = useState<readonly PackageFileEntry[] | null>(null);
  if (base === null && query.isSuccess && query.isFetchedAfterMount) setBase(query.data.entries);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [generation, setGeneration] = useState(0);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replacePath = useRef<string | null>(null);
  const id = useId();
  const limit = formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES);
  const busy = disabled || uploading;
  if (!active) return null;
  if (!base)
    return query.isError ? <ErrorState message={t("files.errorLoad")} /> : <LoadingState />;

  const entries = projectDraftFiles(base, operations, type).map((entry) =>
    entry.path === PACKAGE_MANIFEST_FILE
      ? { ...entry, inline: JSON.stringify(manifest, null, 2) }
      : entry,
  );
  const current = pickActiveEntry(entries, selected, primaryDisplayFile(type).name);
  const stage = (added: PackageFileWriteOperation[], select?: string) => {
    try {
      const next = stageFileOperations(operations, added);
      projectDraftFiles(base, next, type);
      onChange(next);
      if (select !== undefined) setSelected(select);
      setDialog(null);
    } catch (error) {
      toast.error(t(packageFilesErrorKey(error) ?? "files.errorGeneric", { limit }));
    }
  };
  const pick = (path: string | null) => {
    replacePath.current = path;
    if (uploadRef.current) {
      uploadRef.current.multiple = path === null;
      uploadRef.current.click();
    }
  };
  const upload = async (files: File[]) => {
    if (files.some((file) => file.size > PACKAGE_FILE_INLINE_MAX_BYTES)) {
      toast.error(t("files.errorTooLarge", { limit }));
      return;
    }
    const target = replacePath.current;
    if (target === null) {
      // Validate the complete selection before reading or staging anything.
      // Include earlier selections so one import cannot overwrite itself.
      const planned = [...entries];
      for (const file of files) {
        const rejection = validateNewPath(planned, file.name);
        if (rejection) {
          toast.error(
            t(
              rejection === "exists" || rejection === "conflict"
                ? "files.errorImportConflict"
                : NEW_PATH_ERROR_KEYS[rejection],
              { path: file.name },
            ),
          );
          return;
        }
        planned.push({ path: file.name, size: file.size, media_kind: "binary" });
      }
    }
    setUploading(true);
    onBusyChange(true);
    try {
      const added: PackageFileWriteOperation[] = await Promise.all(
        files.map((file) => uploadedFileOperation(target ?? file.name, file)),
      );
      setGeneration((value) => value + 1);
      stage(added, added[0]?.op === "write" ? added[0].path : undefined);
    } catch {
      toast.error(t("files.errorGeneric"));
    } finally {
      setUploading(false);
      onBusyChange(false);
    }
  };
  const pinned = (path: string) => isPinnedEntry(type, path);
  const editable =
    current && current.path !== PACKAGE_MANIFEST_FILE && previewBlockReason(current) === null;
  const replacementAction =
    current && current.path !== PACKAGE_MANIFEST_FILE ? (
      <Button variant="outline" disabled={busy} onClick={() => pick(current.path)}>
        {t("files.replace")}
      </Button>
    ) : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t("files.pendingHint")}</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <FileTree
          entries={entries}
          selectedPath={current?.path ?? null}
          onSelect={setSelected}
          label={t("files.treeLabel")}
          controlsId={id}
          className="border-border bg-card max-h-[560px] rounded-lg border"
          actions={{
            onCreate: () => setDialog({ kind: "create" }),
            onUpload: () => pick(null),
            onRename: (path) => setDialog({ kind: "rename", path }),
            onDelete: (path) => setDialog({ kind: "delete", path }),
            isPinned: pinned,
            isBusy: busy,
            labels: {
              newFile: t("files.newFile"),
              upload: t("files.upload"),
              rename: t("files.rename"),
              delete: t("files.delete"),
            },
          }}
        />
        {current &&
          (editable ? (
            <DraftFilePane
              key={`${current.path}:${generation}`}
              id={id}
              packageId={packageId}
              entry={current}
              disabled={busy}
              actions={replacementAction}
              onChange={(text) => stage([fileTextOperation(current.path, text)])}
            />
          ) : (
            <FilePreview
              id={id}
              packageId={packageId}
              version={undefined}
              entry={current}
              downloadPath={current.sourcePath ?? null}
              actions={replacementAction}
            />
          ))}
      </div>
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
      {dialog?.kind === "create" && (
        <FilePathDialog
          title={t("files.newFile")}
          confirmLabel={t("btn.create", { ns: "common" })}
          initialPath=""
          entries={entries}
          onClose={() => setDialog(null)}
          onSubmit={(path) => stage([fileTextOperation(path, "")], path)}
        />
      )}
      {dialog?.kind === "rename" && (
        <FilePathDialog
          title={t("files.newName")}
          confirmLabel={t("files.rename")}
          initialPath={dialog.path}
          entries={entries.filter((entry) => entry.path !== dialog.path)}
          onClose={() => setDialog(null)}
          onSubmit={(to) => stage([{ op: "move", from: dialog.path, to }], to)}
        />
      )}
      <ConfirmModal
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(null)}
        title={t("files.delete")}
        description={t("files.deleteConfirm", {
          path: dialog?.kind === "delete" ? dialog.path : "",
        })}
        confirmLabel={t("files.delete")}
        isPending={busy}
        onConfirm={() => dialog?.kind === "delete" && stage([{ op: "delete", path: dialog.path }])}
      />
    </div>
  );
}

function DraftFilePane({
  id,
  packageId,
  entry,
  disabled,
  actions,
  onChange,
}: {
  id: string;
  packageId: string;
  entry: DraftFile;
  disabled: boolean;
  actions: ReactNode;
  onChange: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { text, isLoading, isError } = usePackageFile(
    packageId,
    undefined,
    entry.sourcePath ? { ...entry, path: entry.sourcePath } : entry,
    true,
  );
  return (
    <div id={id} role="region" aria-label={entry.path} className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-sm">{entry.path}</p>
        {actions}
      </div>
      {isError ? (
        <ErrorState message={t("files.errorLoad")} />
      ) : isLoading || text === undefined ? (
        <LoadingState />
      ) : (
        <ContentEditor
          value={text}
          onChange={onChange}
          language={languageForPath(entry.path)}
          readOnly={disabled}
        />
      )}
    </div>
  );
}
