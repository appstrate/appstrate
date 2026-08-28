// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Braces, FileOutput, LoaderCircle } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { useDocuments } from "../../hooks/use-documents";
import { classifyRunResults } from "../../lib/run-results";
import { AgentDetailSectionHeader, AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { DocumentListPanel } from "../document-list-panel";
import { JsonView } from "../json-view";
import { EmptyState } from "../page-states";
import { MemoryPanel } from "../persistence/memory-panel";
import { RailButton } from "../settings/rail-link";
import { RunDeliverableTab } from "../run-deliverable-tab";

const keepUnavailableDocumentVisible = () => undefined;

type ResultsSectionId = "production" | "structured" | "memory";

export function RunResultsView({
  run,
  packageId,
  output,
  hasRunMemory,
  isRunning,
}: {
  run: EnrichedRun;
  packageId: string;
  output: Record<string, unknown> | null;
  hasRunMemory: boolean;
  isRunning: boolean;
}) {
  const { t } = useTranslation("agents");
  const [requestedSection, setRequestedSection] = useState<ResultsSectionId>("production");
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
  const sections = [
    ...(shouldRenderDocuments
      ? [
          {
            id: "production" as const,
            icon: FileOutput,
            label: t("run.resultsProduction"),
            description: t("run.resultsProductionDescription"),
          },
        ]
      : []),
    ...(hasStructuredOutput
      ? [
          {
            id: "structured" as const,
            icon: Braces,
            label: t("run.resultsStructuredOutput"),
            description: t("run.resultsStructuredOutputDescription"),
          },
        ]
      : []),
    ...(hasRunMemory
      ? [
          {
            id: "memory" as const,
            icon: BrainCircuit,
            label: t("run.resultsMemoryChanges"),
            description: t("run.resultsMemoryChangesDescription"),
          },
        ]
      : []),
  ];
  const activeSection =
    sections.find((section) => section.id === requestedSection) ?? sections[0] ?? null;

  if (!hasProduction && !documentsQuery.isLoading) {
    return (
      <div className="p-6">
        <EmptyState
          icon={isRunning ? LoaderCircle : FileOutput}
          message={isRunning ? t("run.resultsPending") : t("run.resultsEmpty")}
          hint={isRunning ? t("run.resultsPendingHint") : t("run.resultsEmptyHint")}
        />
      </div>
    );
  }

  if (!activeSection) return null;

  const sectionBody = (() => {
    if (activeSection.id === "production") {
      if (outputDocuments.length === 1 && !documentsQuery.error) {
        return (
          <RunDeliverableTab
            documentId={outputDocuments[0]!.id}
            onUnavailable={keepUnavailableDocumentVisible}
          />
        );
      }
      return (
        <DocumentListPanel
          documents={outputDocuments}
          isLoading={documentsQuery.isLoading}
          error={documentsQuery.error}
          empty={{ message: t("run.resultsNoFiles"), compact: true }}
          runId={run.id}
          showPurposeTabs={false}
          display="table"
          tableSurface="integrated"
        />
      );
    }
    if (activeSection.id === "structured") {
      return output ? <JsonView data={output} /> : null;
    }
    return <MemoryPanel packageId={packageId} runId={run.id} />;
  })();

  return (
    <AgentDetailSplit
      data-run-results-split
      railClassName="p-3"
      rail={
        <nav
          className="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto"
          aria-label={t("run.tabResults")}
        >
          {sections.map((section) => (
            <RailButton
              key={section.id}
              icon={section.icon}
              label={section.label}
              active={activeSection.id === section.id}
              onClick={() => setRequestedSection(section.id)}
            />
          ))}
        </nav>
      }
    >
      <section className="min-w-0 p-6">
        <AgentDetailSectionHeader
          title={activeSection.label}
          description={activeSection.description}
        />
        <div className="space-y-4">
          {isPartial && (
            <Alert>
              <FileOutput />
              <AlertTitle>{t("run.resultsPartial")}</AlertTitle>
              <AlertDescription>{t("run.resultsPartialHint")}</AlertDescription>
            </Alert>
          )}
          {sectionBody}
        </div>
      </section>
    </AgentDetailSplit>
  );
}
