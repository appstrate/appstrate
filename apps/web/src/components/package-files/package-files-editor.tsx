// SPDX-License-Identifier: Apache-2.0

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { primaryDisplayFile } from "../../lib/package-files";
import {
  projectDraftFiles,
  fileTextOperation,
  type DraftFile,
} from "../../lib/package-file-drafts";
import {
  isPinnedEntry,
  languageForPath,
  pickActiveEntry,
  previewBlockReason,
  type PackageFileEntry,
  type PackageFileWriteOperation,
} from "../../lib/package-file-tree";
import { ContentEditor } from "../package-editor/content-editor";
import { LoadingState, ErrorState } from "../page-states";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";
import { usePackageFile } from "./use-package-file";
import { useStagedPackageFiles } from "./use-staged-package-files";

interface Props {
  packageId: string | undefined;
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
      params: { path: splitPackageRef(packageId ?? ""), header: scope.header },
    },
    { enabled: scope.enabled && !!packageId, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  );
  // Keep the tree this draft started from. Refetches cannot silently rebase it;
  // the parent's original ETag (sent as If-Match) rejects any intervening write.
  const [base, setBase] = useState<readonly PackageFileEntry[] | null>(() =>
    packageId ? null : [{ path: PACKAGE_MANIFEST_FILE, size: 0, media_kind: "text", inline: "" }],
  );
  if (base === null && query.isSuccess && query.isFetchedAfterMount) setBase(query.data.data);
  const [selected, setSelected] = useState<string | null>(null);
  const id = useId();
  const manifestText = JSON.stringify(manifest, null, 2);
  const entries =
    active && base
      ? projectDraftFiles(base, operations, type).map((entry) =>
          entry.path === PACKAGE_MANIFEST_FILE
            ? {
                ...entry,
                inline: manifestText,
                size: new TextEncoder().encode(manifestText).byteLength,
              }
            : entry,
        )
      : [];
  const files = useStagedPackageFiles({
    type,
    base: base ?? undefined,
    entries,
    operations,
    onChange,
    onSelect: setSelected,
    disabled,
    onBusyChange,
  });
  if (!active) return null;
  if (!base)
    return query.isError ? <ErrorState message={t("files.errorLoad")} /> : <LoadingState />;

  const current = pickActiveEntry(entries, selected, primaryDisplayFile(type).name);
  const busy = files.busy;
  const editable =
    current && current.path !== PACKAGE_MANIFEST_FILE && previewBlockReason(current) === null;
  const replacementAction =
    current && current.path !== PACKAGE_MANIFEST_FILE ? (
      <Button variant="outline" disabled={busy} onClick={() => files.pickUpload(current.path)}>
        {t("files.replace")}
      </Button>
    ) : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {t(packageId ? "files.pendingHint" : "files.createHint")}
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <FileTree
          entries={entries}
          selectedPath={current?.path ?? null}
          onSelect={setSelected}
          label={t("files.treeLabel")}
          controlsId={id}
          className="border-border bg-card max-h-[560px] rounded-lg border"
          actions={{
            onCreate: files.openNewFile,
            onUpload: () => files.pickUpload(null),
            onRename: files.openRename,
            onDelete: files.openDelete,
            isPinned: (path) => isPinnedEntry(type, path),
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
              key={`${current.path}:${files.imports}`}
              id={id}
              packageId={packageId}
              entry={current}
              disabled={busy}
              actions={replacementAction}
              onChange={(text) => files.stage([fileTextOperation(current.path, text)])}
            />
          ) : (
            <FilePreview
              id={id}
              packageId={packageId}
              version={undefined}
              entry={current}
              downloadPath={packageId ? (current.sourcePath ?? null) : null}
              actions={replacementAction}
            />
          ))}
      </div>
      {files.dialogs}
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
  packageId: string | undefined;
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
          // The region label above stops being announced the moment Monaco
          // takes focus; inside the textarea the open file has to name itself.
          ariaLabel={entry.path}
        />
      )}
    </div>
  );
}
