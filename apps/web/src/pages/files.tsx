// SPDX-License-Identifier: Apache-2.0

/** The Files page: the current space's files gallery, and the storage alert of the org. */

import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useOrgStorage } from "../hooks/use-org-storage";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { PageHeader } from "../components/page-header";
import { FilesCollection } from "../components/files-collection";
import { useOverviewMode } from "../hooks/use-overview-mode";

export function FilesPage() {
  const { t } = useTranslation(["files", "common"]);
  // Remount on space switch so the loaded pages reset.
  const spaceId = useCurrentSpaceId();
  const { storage, limitBytes: limit } = useOrgStorage();
  const overLimit = storage !== undefined && limit !== null && storage.used_bytes >= limit;
  // « Vue d'ensemble »: every space by default.
  const { on: overview } = useOverviewMode();

  return (
    <div>
      <PageHeader
        title={t("common:nav.files")}
        variant="collection"
        breadcrumbs={[{ label: t("common:nav.files") }]}
      />
      {overLimit && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle size={16} />
          <AlertDescription>{t("storage.limitReached")}</AlertDescription>
        </Alert>
      )}
      <FilesCollection key={spaceId ?? "none"} spaceDefault={overview ? "all" : "current"} />
    </div>
  );
}
