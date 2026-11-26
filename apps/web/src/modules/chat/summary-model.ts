// SPDX-License-Identifier: Apache-2.0

/**
 * What the summary draws of a conversation's activity, from the reads behind it: pure, so the
 * sections it leaves out and the counts it shows are tested apart from the panel.
 */

import type { ConversationToolCall } from "@appstrate/module-chat/conversation-tools";

/** The latest lines each group of the summary draws before its "See all". */
export const SUMMARY_ROWS = 3;

/** A list the server counts: its first rows and how many match in all. */
export interface CountedRows<T> {
  rows: readonly T[];
  total: number;
}

/** A list the server does not count: its first rows and whether more follow. */
export interface PagedRows<T> {
  rows: readonly T[];
  hasMore: boolean;
}

export interface SummaryInput<Run extends { id: string }, File> {
  /** The conversation's calls, in conversation order. */
  calls: readonly ConversationToolCall[];
  /** The latest runs; absent when the reader reads runs in no space. */
  runs?: CountedRows<Run>;
  /**
   * The latest runs that failed, as many as the Runs tab lists: the summary draws a few, and a
   * failed call whose run is among any of them is left to that run. Absent with `runs`, or while
   * they cannot be read: every failed call then stands on its own.
   */
  failedRuns?: CountedRows<Run>;
  /** The latest files; absent when the reader reads files in no space. */
  files?: PagedRows<File>;
}

export interface SummaryGroup<T> {
  /** Latest first, {@link SUMMARY_ROWS} at most. */
  rows: T[];
  /** How many the group holds in all; absent when the server does not count it (files). */
  total?: number;
  /** The group holds more than its rows: it leads to its tab. */
  more: boolean;
}

export interface SummaryModel<Run, File> {
  /**
   * What failed (runs, then calls), absent when nothing did. `moreRuns` / `moreCalls`: it holds
   * more of that kind than it draws, so it leads to that kind's tab.
   */
  attention: {
    runs: Run[];
    calls: ConversationToolCall[];
    count: number;
    moreRuns: boolean;
    moreCalls: boolean;
  } | null;
  runs: SummaryGroup<Run> | null;
  files: SummaryGroup<File> | null;
  /** The calls that acted (lookups apart). */
  actions: SummaryGroup<ConversationToolCall> | null;
}

/**
 * The calls that failed, latest first, a failed lookup included. A call whose run is among the
 * failed runs read (`failedRunIds`) is left to that run: its failure is the run's, listed once with
 * the runs. One whose run did not fail (a wait cut short while the run goes on) stays.
 */
export function failedCalls(
  calls: readonly ConversationToolCall[],
  failedRunIds: ReadonlySet<string>,
): ConversationToolCall[] {
  return calls
    .filter(
      (call) =>
        call.status === "error" && !(call.runId !== undefined && failedRunIds.has(call.runId)),
    )
    .reverse();
}

function counted<T>(list: CountedRows<T> | undefined): SummaryGroup<T> | null {
  if (!list || list.total === 0) return null;
  const rows = list.rows.slice(0, SUMMARY_ROWS);
  return { rows, total: list.total, more: list.total > rows.length };
}

/** Each section of the summary's activity, or `null` for one it leaves out. */
export function summaryModel<Run extends { id: string }, File>({
  calls,
  runs,
  failedRuns,
  files,
}: SummaryInput<Run, File>): SummaryModel<Run, File> {
  const failed = failedCalls(calls, new Set((failedRuns?.rows ?? []).map((run) => run.id)));
  // The failed runs the server counts, then the failed calls no failed run already holds.
  const failedRunCount = failedRuns?.total ?? 0;
  const attentionCount = failedRunCount + failed.length;
  const attentionRuns = (failedRuns?.rows ?? []).slice(0, SUMMARY_ROWS);
  const attentionCalls = failed.slice(0, SUMMARY_ROWS);
  const actions = calls.filter((call) => !call.lookup).reverse();
  const fileRows = files?.rows.slice(0, SUMMARY_ROWS) ?? [];
  return {
    attention:
      attentionCount === 0
        ? null
        : {
            runs: attentionRuns,
            calls: attentionCalls,
            count: attentionCount,
            moreRuns: failedRunCount > attentionRuns.length,
            moreCalls: failed.length > attentionCalls.length,
          },
    runs: counted(runs),
    files:
      files && fileRows.length > 0
        ? { rows: fileRows, more: files.hasMore || files.rows.length > fileRows.length }
        : null,
    actions: counted({ rows: actions, total: actions.length }),
  };
}
