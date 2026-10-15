// SPDX-License-Identifier: Apache-2.0

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { PACKAGE_MANIFEST_FILE } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import { primaryDisplayFile } from "../../lib/package-files";
import { projectDraftFiles, fileTextOperation } from "../../lib/package-file-drafts";
import {
  isPinnedEntry,
  pickActiveEntry,
  previewBlockReason,
  type PackageFileEntry,
  type PackageFileWriteOperation,
} from "../../lib/package-file-tree";
import { ErrorState } from "../page-states";
import { TextSkeleton } from "../loading-skeletons";
import { FileTree } from "./file-tree";
import { PackageFileSource } from "./package-file-source";
import { PackageFileTextEditor } from "./package-file-text-editor";
import { usePackageFileIndex } from "./use-package-file-index";
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
  const query = usePackageFileIndex(packageId, undefined, true);
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
    return query.isError ? (
      <ErrorState message={t("files.errorLoad")} />
    ) : (
      <TextSkeleton lines={6} />
    );

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
          }}
        />
        {current &&
          (editable ? (
            <div
              key={`${current.path}:${files.imports}`}
              id={id}
              role="region"
              aria-label={current.path}
              className="min-w-0"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-mono text-sm">{current.path}</p>
                {replacementAction}
              </div>
              <PackageFileTextEditor
                packageId={packageId}
                entry={current.sourcePath ? { ...current, path: current.sourcePath } : current}
                path={current.path}
                commit="live"
                disabled={busy}
                onCommit={(text) => files.stage([fileTextOperation(current.path, text)])}
              />
            </div>
          ) : (
            <PackageFileSource
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
