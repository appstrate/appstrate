// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Outcome" pane — everything the run PRODUCED, in one place:
 *
 *   1. Output      — the value the `output` tool emitted. Not "the result of
 *                    the run": it is literally what that one tool wrote, which
 *                    is why the section carries the tool's own name.
 *   2. Fichiers    — the files the run produced. Inputs it merely consumed are
 *                    NOT here; the Fichiers tab is where the complete list,
 *                    imported and produced, lives.
 *   3. Mémoire     — the memory rows the run wrote or touched.
 *
 * Each section is present only when the run has that kind of outcome, and a run
 * that produced none of the three says so once instead of stacking three empty
 * cards. Memory in particular is the rare case: keeping a permanently-empty
 * "Mémoire" card on every run page would train the reader to ignore the pane.
 *
 * The file list reads the SAME query as the Fichiers tab (the run's files in
 * one page, filtered client-side), so the two panes cost one request between
 * them and cannot disagree about what the run produced.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PackageOpen } from "lucide-react";
import { useFiles, type FileDto } from "../hooks/use-files";
import { featuredRunFile, producedRunFiles } from "../lib/files";
import { FileListPanel } from "./file-list-panel";
import { RunFeaturedFile } from "./run-featured-file";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { EmptyState } from "./page-states";
import { MemoryPanel } from "./persistence/memory-panel";

interface RunOutcomeProps {
  runId: string;
  packageId: string;
  /** The `output` tool's value, or `null` when the run emitted none. */
  output: Record<string, unknown> | null;
  /** Memory rows written or touched by this run — the section's badge. */
  memoryCount: number;
}

/** Fetches the run's files and hands them to the view. */
export function RunOutcomeTab(props: RunOutcomeProps) {
  const { data, isLoading, error } = useFiles({ runId: props.runId, limit: 100 });
  return <RunOutcomeView {...props} files={data?.data ?? []} isLoading={isLoading} error={error} />;
}

/**
 * The pane itself, fed an already-resolved list.
 *
 * Split from the fetch so which sections appear — and which files reach them —
 * is testable without a query harness. That decision is the whole of the
 * derived presentation rule (#1177) and of "produced only", so it is the part
 * that must not be assumed correct.
 */
export function RunOutcomeView({
  runId,
  packageId,
  output,
  memoryCount,
  files,
  isLoading,
  error,
}: RunOutcomeProps & {
  files: FileDto[];
  isLoading: boolean;
  error: unknown;
}) {
  const { t } = useTranslation(["agents", "files"]);

  // Produced by THIS run ONLY. The Fichiers tab is where the complete list
  // lives; a pane titled "what this run produced" that quietly included the
  // files it consumed would be lying about the one thing it exists to say —
  // and the query answers the run's whole container, so a file chained in from
  // an earlier run arrives here carrying `agent_output` and is told apart only
  // by its own `run_id`.
  const produced = useMemo(() => producedRunFiles(files, runId), [files, runId]);
  // Derived from the produced files alone (#1177) — exactly one is featured and
  // opened, several are only listed and the user picks.
  const featured = useMemo(() => featuredRunFile(files, runId), [files, runId]);

  const hasOutput = !!output && Object.keys(output).length > 0;
  const hasFiles = isLoading || !!error || produced.length > 0;
  const hasMemory = memoryCount > 0;

  if (!hasOutput && !hasFiles && !hasMemory) {
    return (
      <EmptyState
        message={t("run.outcomeEmpty")}
        hint={t("run.outcomeEmptyHint")}
        icon={PackageOpen}
        compact
      />
    );
  }

  return (
    <div>
      {hasOutput && (
        <SectionCard title={t("run.sectionOutput")}>
          <JsonView data={output} />
        </SectionCard>
      )}

      {hasFiles && (
        <SectionCard title={t("run.sectionProducedFiles")}>
          {featured && <RunFeaturedFile id={featured.id} name={featured.name} />}
          {/* No purpose filter: this list is produced files by construction. */}
          <FileListPanel
            files={produced}
            isLoading={isLoading}
            error={error}
            empty={{ message: t("run.empty", { ns: "files" }), compact: true }}
            runId={runId}
          />
        </SectionCard>
      )}

      {hasMemory && (
        <SectionCard
          title={t("run.sectionMemory")}
          headerRight={
            <span className="bg-primary/15 text-primary inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-medium">
              {memoryCount}
            </span>
          }
        >
          <MemoryPanel packageId={packageId} runId={runId} />
        </SectionCard>
      )}
    </div>
  );
}
