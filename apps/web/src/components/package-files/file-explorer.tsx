// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only file explorer for a package artifact: the tree of every file in the
 * snapshot plus a preview of the selected one. Generic across package types —
 * the type only decides which file is pre-selected.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { $api } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { splitPackageRef } from "../../lib/package-paths";
import { primaryDisplayFile } from "../../lib/package-files";
import type { PackageFileEntry } from "../../lib/package-file-tree";
import { LoadingState, ErrorState, EmptyState } from "../page-states";
import { ReadOnlyFileTree } from "./read-only-file-tree";
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
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  if (loadError) return <ErrorState />;
  // Covers the disabled-query window too: with no org/app yet the query never
  // starts, and `isLoading` would be false while `data` is still absent.
  if (!data) return <LoadingState />;
  if (entries.length === 0) {
    return <EmptyState icon={FolderOpen} message={t("files.empty")} compact />;
  }

  // Derived, not state: a stale selection (version switch dropped the file)
  // falls back to the default instead of being repaired by an effect, and a
  // re-render never clobbers a selection the user made.
  const activeEntry =
    (selectedPath ? byPath.get(selectedPath) : undefined) ??
    byPath.get(primaryDisplayFile(type).name) ??
    entries[0]!;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <ReadOnlyFileTree
        // Remount on snapshot change: the expansion set is seeded from the tree,
        // so a different artifact must start from its own defaults.
        key={version ?? "draft"}
        entries={entries}
        selectedPath={activeEntry.path}
        onSelect={setSelectedPath}
        label={t("files.treeLabel")}
        className="border-border bg-card max-h-[560px] rounded-lg border p-1"
      />
      <FilePreview packageId={packageId} version={version} entry={activeEntry} />
    </div>
  );
}
