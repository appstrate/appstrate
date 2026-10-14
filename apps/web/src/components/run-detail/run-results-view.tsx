// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Braces, FileOutput, LoaderCircle } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { StructuredOutput } from "@appstrate/ui/components/structured-output";
import { useFiles, type FileDto } from "../../hooks/use-files";
import { usePermissions } from "../../hooks/use-permissions";
import { usePackageDetail } from "../../hooks/use-packages";
import { classifyRunResults } from "../../lib/run-results";
import { AgentDetailSectionHeader, AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { DocumentListPanel } from "../document-list-panel";
import { JsonView } from "../json-view";
import { EmptyState } from "../page-states";
import { MemoryPanel } from "../persistence/memory-panel";
import { RailButton } from "../settings/rail-link";
import { featuredRunFile, producedRunFiles } from "../../lib/files";
import { RunDeliverableTab } from "../run-deliverable-tab";

const keepUnavailableDocumentVisible = () => undefined;

type ResultsSectionId = "production" | "structured" | "memory";

interface RunResultsProps {
  run: EnrichedRun;
  packageId: string;
  output: Record<string, unknown> | null;
  hasRunMemory: boolean;
  isRunning: boolean;
}

/** Fetches the run's file container and hands it to the view. */
export function RunResultsView(props: RunResultsProps) {
  const { data, isLoading, error } = useFiles({ runId: props.run.id, limit: 100 });
  const { can } = usePermissions();
  return (
    <RunResultsContent
      {...props}
      files={data?.data ?? []}
      hasMore={data?.hasMore ?? false}
      isLoading={isLoading}
      error={error}
      filesDenied={!can("files:read")}
    />
  );
}

/** The results, fed an already-resolved file list: testable without a query harness. */
export function RunResultsContent({
  run,
  packageId,
  output,
  hasRunMemory,
  isRunning,
  files,
  hasMore,
  isLoading,
  error,
  filesDenied,
}: RunResultsProps & {
  files: FileDto[];
  /** The 100-row page was capped: the run's file container holds more rows. */
  hasMore: boolean;
  isLoading: boolean;
  error: unknown;
  /** The caller may not list files (`files:read`), so none were fetched. */
  filesDenied: boolean;
}) {
  const { t } = useTranslation("agents");
  const [requestedSection, setRequestedSection] = useState<ResultsSectionId>("production");
  // The labels of the structured output: an inline run carries its manifest,
  // an agent run reads its package (the same query the page already made, so
  // this is a cache hit, and skipped for inline shadows, which would 404).
  const isInline = packageId.startsWith("@inline/");
  const { data: agent } = usePackageDetail("agent", isInline ? undefined : packageId);
  const outputSchema = isInline
    ? (run.inline_manifest?.output as { schema?: unknown } | undefined)?.schema
    : agent?.output?.schema;
  // What the run PRODUCED: the query answers the run's whole container, so a
  // file chained in from an earlier run arrives carrying `agent_output` and is
  // told apart only by its own `runId` (`producedRunFiles`).
  const outputDocuments = useMemo(() => producedRunFiles(files, run.id), [files, run.id]);
  // `hasMore` describes the whole container, inputs included: the produced list
  // is cut only when fewer produced rows arrived than the run's own count.
  const producedCut = hasMore && outputDocuments.length < run.file_counts.output;
  const { hasStructuredOutput, shouldRenderDocuments, hasProduction, isPartial } =
    classifyRunResults({
      status: run.status,
      output,
      expectedDocumentCount: run.file_counts.output,
      loadedDocumentCount: outputDocuments.length,
      documentsLoading: isLoading,
      documentsError: Boolean(error),
      hasRunMemory,
      // The featured file is DERIVED: a run that produced exactly one file
      // features it, zero or several feature none.
      hasPrimaryDocument: Boolean(featuredRunFile(files, run.id)),
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

  if (!hasProduction && !isLoading) {
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
      // The single produced file leads in its viewer; its row stays below it,
      // where its download, keep and delete live.
      const featured = outputDocuments.length === 1 && !error ? outputDocuments[0] : undefined;
      return (
        <>
          {featured && (
            <RunDeliverableTab
              fileId={featured.id}
              onUnavailable={keepUnavailableDocumentVisible}
            />
          )}
          <DocumentListPanel
            documents={outputDocuments}
            isLoading={isLoading}
            error={error}
            empty={{
              message: filesDenied ? t("run.noAccess", { ns: "files" }) : t("run.resultsNoFiles"),
              compact: true,
            }}
            runId={run.id}
            display="table"
            tableSurface="integrated"
            footer={
              producedCut && (
                <p className="text-muted-foreground text-xs">{t("run.producedFilesTruncated")}</p>
              )
            }
          />
        </>
      );
    }
    if (activeSection.id === "structured") {
      return output ? <StructuredOutputBody output={output} schema={outputSchema} /> : null;
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

/** The output as labelled facts, its raw JSON one toggle away. */
function StructuredOutputBody({
  output,
  schema,
}: {
  output: Record<string, unknown>;
  schema: unknown;
}) {
  const { t } = useTranslation("agents");
  const [showJson, setShowJson] = useState(false);
  return (
    <div className="space-y-4">
      {showJson ? <JsonView data={output} /> : <StructuredOutput value={output} schema={schema} />}
      <Button variant="outline" size="sm" onClick={() => setShowJson((v) => !v)}>
        <Braces />
        {showJson ? t("run.outputShowFields") : t("run.outputShowJson")}
      </Button>
    </div>
  );
}
