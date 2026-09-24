// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only file explorer for a package artifact: the tree of every file in the
 * snapshot plus a preview of the selected one. Generic across package types —
 * the type only decides which file is pre-selected.
 */

import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { $api, ApiError } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { primaryDisplayFile } from "../../lib/package-files";
import { pickActiveEntry, type PackageFileEntry } from "../../lib/package-file-tree";
import { LoadingState, ErrorState, EmptyState } from "../page-states";
import { FileTree } from "./file-tree";
import { FilePreview } from "./file-preview";

interface FileExplorerProps {
  packageId: string;
  type: PackageType;
  /** Pinned version to read, or `undefined` for the live draft. */
  version?: string;
}

export function FileExplorer({ packageId, type, version }: FileExplorerProps) {
  const { t } = useTranslation("agents");
  const scope = useOrgScope();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Ties the tree to the panel it drives (`aria-controls` → `id`).
  const previewId = useId();

  const { data, error: loadError } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: {
        path: splitPackageRef(packageId),
        ...(version ? { query: { version } } : {}),
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );

  const entries: PackageFileEntry[] = useMemo(() => data?.entries ?? [], [data]);
  const activeEntry = useMemo(
    () => pickActiveEntry(entries, selectedPath, primaryDisplayFile(type).name),
    [entries, selectedPath, type],
  );

  // A version whose stored archive is gone or unreadable is not a network blip
  // and must not read like one: the API answers `422 version_artifact_unavailable`
  // (a 404 means the package or version itself does not resolve). Only that
  // code means "this version's files are gone" — anything else gets the
  // generic, retryable message.
  if (loadError) {
    const missing =
      loadError instanceof ApiError && loadError.code === "version_artifact_unavailable";
    return <ErrorState message={t(missing ? "files.errorMissingArtifact" : "files.errorLoad")} />;
  }
  // Covers the disabled-query window too: with no org/app yet the query never
  // starts, and `isLoading` would be false while `data` is still absent.
  if (!data) return <LoadingState />;
  if (activeEntry === null) {
    return <EmptyState icon={FolderOpen} message={t("files.empty")} compact />;
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <FileTree
        entries={entries}
        selectedPath={activeEntry.path}
        onSelect={setSelectedPath}
        label={t("files.treeLabel")}
        controlsId={previewId}
        className="border-border bg-card max-h-[560px] rounded-lg border"
      />
      <FilePreview id={previewId} packageId={packageId} version={version} entry={activeEntry} />
    </div>
  );
}
