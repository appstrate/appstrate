// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { RunInfoTab } from "../run-info-tab";
import type { RunTurnRow } from "../log-utils";
import { RunSourceCard } from "./run-source-card";
import { useDocuments } from "../../hooks/use-documents";
import { DocumentListPanel } from "../document-list-panel";
import { SectionCard } from "../section-card";

export function RunSnapshotInspector({
  run,
  turns,
  showHeading = true,
}: {
  run: EnrichedRun;
  turns: RunTurnRow[];
  showHeading?: boolean;
}) {
  const { t } = useTranslation("agents");
  const inputDocumentsQuery = useDocuments({
    runId: run.id,
    purpose: "user_upload",
    limit: 100,
  });
  const inputDocuments = inputDocumentsQuery.data?.data ?? [];

  return (
    <div className="space-y-4" data-run-snapshot>
      {showHeading && (
        <div>
          <h2 className="text-base font-semibold">{t("run.snapshotTitle")}</h2>
          <p className="text-muted-foreground mt-1 text-xs">{t("run.snapshotHint")}</p>
        </div>
      )}

      <RunSourceCard run={run} />
      {(run.document_counts.input > 0 ||
        inputDocumentsQuery.isLoading ||
        Boolean(inputDocumentsQuery.error)) && (
        <SectionCard title={t("run.snapshotInputFiles")}>
          <DocumentListPanel
            documents={inputDocuments}
            isLoading={inputDocumentsQuery.isLoading}
            error={inputDocumentsQuery.error}
            empty={{ message: t("run.snapshotInputFilesUnavailable"), compact: true }}
            runId={run.id}
            showPurposeTabs={false}
          />
        </SectionCard>
      )}
      <RunInfoTab run={run} turns={turns} />
    </div>
  );
}
