// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { useDocuments } from "../../hooks/use-documents";
import { DocumentListPanel } from "../document-list-panel";
import { JsonView } from "../json-view";
import { MemoryPanel } from "../persistence/memory-panel";
import { SectionCard } from "../section-card";
import { EmptyState } from "../page-states";
import { FileOutput } from "lucide-react";
import { RunSourceCard } from "./run-source-card";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { RunDeliverableTab } from "../run-deliverable-tab";
import { classifyRunResults } from "../../lib/run-results";

const keepUnavailableDocumentVisible = () => undefined;

export function RunResultsView({
  run,
  packageId,
  output,
  hasRunMemory,
}: {
  run: EnrichedRun;
  packageId: string;
  output: Record<string, unknown> | null;
  hasRunMemory: boolean;
}) {
  const { t } = useTranslation("agents");
  const documentsQuery = useDocuments({ runId: run.id, limit: 100 });
  const outputDocuments = useMemo(
    () =>
      (documentsQuery.data?.data ?? []).filter((document) => document.purpose === "agent_output"),
    [documentsQuery.data?.data],
  );
  const { hasStructuredOutput, shouldRenderDocuments, hasProduction, isPartial } =
    classifyRunResults({
      status: run.status,
      output,
      expectedDocumentCount: run.document_counts.output,
      loadedDocumentCount: outputDocuments.length,
      documentsLoading: documentsQuery.isLoading,
      documentsError: Boolean(documentsQuery.error),
      hasRunMemory,
      hasPrimaryDocument: Boolean(run.primary_document_id),
    });

  if (!hasProduction && !documentsQuery.isLoading) {
    return (
      <EmptyState
        icon={FileOutput}
        message={t("run.resultsEmpty")}
        hint={t("run.resultsEmptyHint")}
      />
    );
  }

  return (
    <div className="space-y-6">
      {run.package_ephemeral && <RunSourceCard run={run} />}
      {isPartial && (
        <Alert>
          <FileOutput />
          <AlertTitle>{t("run.resultsPartial")}</AlertTitle>
          <AlertDescription>{t("run.resultsPartialHint")}</AlertDescription>
        </Alert>
      )}
      {shouldRenderDocuments && (
        <SectionCard title={t("run.resultsProduction")}>
          {outputDocuments.length === 1 && !documentsQuery.error ? (
            <RunDeliverableTab
              documentId={outputDocuments[0]!.id}
              onUnavailable={keepUnavailableDocumentVisible}
            />
          ) : (
            <DocumentListPanel
              documents={outputDocuments}
              isLoading={documentsQuery.isLoading}
              error={documentsQuery.error}
              empty={{ message: t("run.resultsNoFiles"), compact: true }}
              runId={run.id}
              showPurposeTabs={false}
            />
          )}
        </SectionCard>
      )}

      {hasStructuredOutput && output && (
        <SectionCard title={t("run.resultsStructuredOutput")}>
          <JsonView data={output} />
        </SectionCard>
      )}

      {hasRunMemory && (
        <SectionCard title={t("run.resultsMemoryChanges")}>
          <MemoryPanel packageId={packageId} runId={run.id} />
        </SectionCard>
      )}
    </div>
  );
}
