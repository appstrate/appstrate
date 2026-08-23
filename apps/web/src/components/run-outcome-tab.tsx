// SPDX-License-Identifier: Apache-2.0

/**
 * Run-detail "Outcome" pane — everything the run PRODUCED, in one place:
 *
 *   1. Fichiers    — the files the run produced. Inputs it merely consumed are
 *                    NOT here; the Fichiers tab is where the complete list,
 *                    imported and produced, lives.
 *   2. Output      — the value the `output` tool emitted. Not "the result of
 *                    the run": it is literally what that one tool wrote, which
 *                    is why the section carries the tool's own name.
 *   3. Mémoire     — the memory rows the run wrote or touched.
 *
 * FILES LEAD, and this order is deliberate — do not put Output back on top.
 * What a run is FOR is the artefact it produced; the `output` tool's JSON is
 * metadata about that artefact (a verdict, a summary, a status), and reading it
 * first means scrolling past it to reach the thing itself. On the common single
 * -file run the file IS the answer, so the pane opens on it.
 *
 * The "Fichiers produits" card always lists what the run produced. Above it,
 * when the run produced exactly ONE file, that file's viewer is HOISTED out of
 * the card and is the first thing on the pane — the derived rule #1177 features
 * a file only at exactly one, so several are listed and the reader picks.
 *
 * The single file therefore appears twice, and that is on purpose: the viewer
 * shows the file, the row carries what the viewer cannot — size, date, download
 * and delete. Dropping the card there would take those away to save a line.
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
import { runHasOutcome, runHasOutputValue } from "../lib/run-detail-tabs";
import { FileListPanel } from "./file-list-panel";
import { RunFeaturedFile, RunFeaturedFilePlaceholder } from "./run-featured-file";
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
  /**
   * How many files the run produced, read off the run DTO's `file_counts.output`
   * (the server counts `run_id = this run AND purpose = 'agent_output'` — the
   * same predicate as {@link producedRunFiles}). It is what decides whether the
   * files lead the pane AT ALL, and — while `/api/files` is still in flight —
   * which of the two shapes they take, so the pane never paints a spinner on a
   * run that produced nothing, never swaps one shape for the other mid-load,
   * and an errored `/api/files` never leaves a permanent empty card there.
   */
  producedFileCount: number;
}

/** Fetches the run's files and hands them to the view. */
export function RunOutcomeTab(props: RunOutcomeProps) {
  const { data, isLoading, error } = useFiles({ runId: props.runId, limit: 100 });
  return (
    <RunOutcomeView
      {...props}
      files={data?.data ?? []}
      // The route clamps `limit` to 100 and answers `hasMore` with no cursor
      // field (paging is `startingAfter=<last id>`). It describes the run's
      // whole CONTAINER, inputs included — see `pageCutProducedFiles` below for
      // why this pane cannot show a notice off it alone.
      hasMore={data?.hasMore ?? false}
      isLoading={isLoading}
      error={error}
    />
  );
}

/**
 * The pane itself, fed an already-resolved list.
 *
 * Split from the fetch so which sections appear — in which order, in which
 * shape, and which files reach them — is testable without a query harness.
 * That decision is the whole of the derived presentation rule (#1177) and of
 * "produced only", so it is the part that must not be assumed correct.
 */
export function RunOutcomeView({
  runId,
  packageId,
  output,
  memoryCount,
  producedFileCount,
  files,
  hasMore,
  isLoading,
  error,
}: RunOutcomeProps & {
  files: FileDto[];
  /**
   * The list query's page was capped — the run's file CONTAINER holds rows
   * beyond it. Not "the produced list was cut": the container ORs the run's own
   * files with the ones its input references, so the inputs count toward it.
   */
  hasMore?: boolean;
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

  // Shared with the page, which feeds the same predicate over the same object
  // into the tab controller — see `runHasOutputValue`.
  const hasOutput = runHasOutputValue(output);
  // Decided by the run DTO's own count, not by the list query's phase. Reading
  // `isLoading || error` here painted the card — spinner and all — on every run
  // with an `output` value and no file, then removed it a moment later (a layout
  // jump on every open), and left it standing forever when `/api/files` errored
  // on a run that had produced nothing at all. `produced.length` is still ORed
  // in so a file that lands while the page is open (SSE invalidates the list)
  // cannot be hidden by a stale count.
  const hasFiles = producedFileCount > 0 || produced.length > 0;
  const hasMemory = memoryCount > 0;

  // WHICH shape, on the same principle and for the same reason: the DTO count
  // is known on the first paint, `featured` only once `/api/files` answers. Read
  // `featured` alone and a single-file run would paint the "Fichiers produits"
  // card for one frame and then replace it with the hoisted viewer — the exact
  // layout jump `hasFiles` above was already fixed once. So the count picks
  // the shape while the list is in flight, and a placeholder holds the top slot.
  //
  // Once the list has ANSWERED, the list wins: a count of 1 whose page turns out
  // to hold three files (or none — deleted between the two reads) is stale, and
  // the resolved rows are the honest ones. `featured` is exactly
  // `produced.length === 1`, so the two branches can never both be taken.
  const singleFileShape = isLoading ? producedFileCount === 1 : featured !== undefined;

  // Was THIS pane's list cut — not the container's.
  //
  // `hasMore` alone answers the wrong question: the run's file query ORs
  // `files.run_id = X` with the ids its input references, so a run with 40
  // produced files and 70 inputs is 110 rows and reports `hasMore` while every
  // one of its 40 produced files is on screen. Reading it here put a
  // "truncated" notice under a complete list, and left the Fichiers tab — the
  // pane that DOES list the container, and is cut by the same page — silent.
  //
  // The honest comparison is against the run DTO's own produced count, the
  // authority on how many there are (`file_counts.output`, the server counting
  // `run_id = this run AND purpose = 'agent_output'`). Fewer produced rows
  // arrived than exist ⇒ the page cut some of them off.
  //
  // `hasMore` still gates it, as a staleness guard rather than the signal: an
  // uncapped page holds the whole container, so the produced list is complete
  // BY CONSTRUCTION and a count that momentarily disagrees (a file deleted
  // between the two reads) must not raise a notice about it.
  const pageCutProducedFiles = hasMore && produced.length < producedFileCount;

  // The SAME rule the tab controller selects the default pane with, not its
  // hand-written De Morgan dual: a drift between the two opens the page on a
  // pane that says the run produced nothing, and the capture is frozen.
  if (!runHasOutcome({ hasFiles, hasOutput, hasMemory })) {
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
      {hasFiles && (
        <>
          {/* The presented artefact leads the page. The card below still lists
              it — the row is where its size, date, download and delete live,
              which the viewer does not carry. */}
          {singleFileShape &&
            (featured ? (
              <RunFeaturedFile id={featured.id} name={featured.name} />
            ) : (
              <RunFeaturedFilePlaceholder />
            ))}
          <SectionCard title={t("run.sectionProducedFiles")}>
            {/* No purpose filter: this list is produced files by construction. */}
            <FileListPanel
              files={produced}
              isLoading={isLoading}
              error={error}
              empty={{ message: t("run.empty", { ns: "files" }), compact: true }}
              runId={runId}
            />
            {pageCutProducedFiles && (
              <p className="text-muted-foreground mt-2 text-xs">
                {t("run.producedFilesTruncated")}
              </p>
            )}
          </SectionCard>
        </>
      )}

      {hasOutput && (
        <SectionCard title={t("run.sectionOutput")}>
          <JsonView data={output} />
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
