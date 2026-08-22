// SPDX-License-Identifier: Apache-2.0

/**
 * Files gallery. Paginated (keyset "load more") list of every file
 * visible to the caller in the current application, with a purpose filter.
 * Visibility is the API's (container-inherited ACL): members see the app's
 * files, end-users see only their own.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { formatBytes } from "@appstrate/core/format";
import { useOrgStorage } from "../hooks/use-org-storage";
import { useCurrentApplicationId } from "../hooks/use-current-application";
import { useFiles, type FileDto } from "../hooks/use-files";
import { PageHeader } from "../components/page-header";
import { FileListPanel, type PurposeFilter } from "../components/file-list-panel";

/**
 * A single storage-usage line ("X used / Y limit") with a conditional warning
 * when consumption has reached or passed the effective limit — at which point
 * new file writes are rejected (403) while existing files stay intact.
 * `effective_limit_bytes` null = unlimited: the line collapses to "X used".
 */
function StorageUsageLine() {
  const { t } = useTranslation(["files"]);
  const { storage, limitBytes: limit } = useOrgStorage();
  if (!storage) return null;

  const over = limit !== null && storage.used_bytes >= limit;

  return (
    <div className="mb-4">
      <p className="text-muted-foreground text-sm tabular-nums">
        {limit === null
          ? t("storage.usedUnlimited", { used: formatBytes(storage.used_bytes) })
          : t("storage.usedOfLimit", {
              used: formatBytes(storage.used_bytes),
              limit: formatBytes(limit),
            })}
      </p>
      {over && (
        <Alert variant="warning" className="mt-2">
          <AlertTriangle size={16} />
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function FilesPage() {
  // Remount on application switch so the cursor + accumulated pages reset.
  const applicationId = useCurrentApplicationId();
  return <FilesPageContent key={applicationId ?? "none"} />;
}

function FilesPageContent() {
  const { t } = useTranslation(["files", "common"]);

  const [purpose, setPurpose] = useState<PurposeFilter>("all");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadedPages, setLoadedPages] = useState<FileDto[]>([]);

  const { data, isLoading, error } = useFiles({
    purpose: purpose === "all" ? undefined : purpose,
    startingAfter: cursor,
    limit: 25,
  });

  const currentPage = useMemo(() => data?.data ?? [], [data?.data]);
  const hasMore = data?.hasMore ?? false;

  // Merge accumulated pages with the current one, deduping by id (the current
  // page briefly overlaps the accumulator between "Load more" and the fetch).
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: FileDto[] = [];
    for (const file of [...loadedPages, ...currentPage]) {
      if (!seen.has(file.id)) {
        seen.add(file.id);
        out.push(file);
      }
    }
    return out;
  }, [loadedPages, currentPage]);

  const resetPaging = (next: PurposeFilter) => {
    setPurpose(next);
    setCursor(undefined);
    setLoadedPages([]);
  };

  return (
    <div className="p-6">
      <PageHeader
        title={t("page.title")}
        emoji="📄"
        breadcrumbs={[
          { label: t("nav.orgSection", { ns: "common" }), href: "/" },
          { label: t("page.title") },
        ]}
      />

      <StorageUsageLine />

      <FileListPanel
        files={files}
        isLoading={isLoading}
        error={error}
        purpose={purpose}
        onPurposeChange={resetPaging}
        empty={{ message: t("page.empty"), hint: t("page.emptyHint") }}
        showRunLink
        onDeleted={(id) => setLoadedPages((prev) => prev.filter((d) => d.id !== id))}
        onKept={(id) =>
          setLoadedPages((prev) => prev.map((d) => (d.id === id ? { ...d, expiresAt: null } : d)))
        }
        footer={
          hasMore && (
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                const last = currentPage[currentPage.length - 1];
                if (last) {
                  setLoadedPages((prev) => [...prev, ...currentPage]);
                  setCursor(last.id);
                }
              }}
            >
              {t("page.loadMore")}
            </Button>
          )
        }
      />
    </div>
  );
}
