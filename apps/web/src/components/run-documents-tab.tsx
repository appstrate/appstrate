// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Documents" tab. Lists the documents anchored to a run — inputs
 * (user uploads consumed by the run) and outputs (agent-produced files) —
 * filtered client-side by the same purpose tabs as the gallery (the run's
 * documents are fetched in one page, so tab switches don't re-query). The list
 * is invalidated live from the run's SSE stream: `run-detail` invalidates this
 * query when a `document.published` log frame arrives, which is also what
 * refreshes it after a delete (useDeleteDocument invalidates the same query).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDocuments } from "../hooks/use-documents";
import { DocumentListPanel, type PurposeFilter } from "./document-list-panel";

export function RunDocumentsTab({ runId }: { runId: string }) {
  const { t } = useTranslation("documents");
  const { data, isLoading, error } = useDocuments({ runId, limit: 100 });
  const [purpose, setPurpose] = useState<PurposeFilter>("all");

  const documents = useMemo(() => {
    const all = data?.data ?? [];
    return purpose === "all" ? all : all.filter((d) => d.purpose === purpose);
  }, [data?.data, purpose]);

  return (
    <DocumentListPanel
      documents={documents}
      isLoading={isLoading}
      error={error}
      purpose={purpose}
      onPurposeChange={setPurpose}
      empty={{ message: t("run.empty"), hint: t("run.emptyHint"), compact: true }}
      runId={runId}
    />
  );
}
