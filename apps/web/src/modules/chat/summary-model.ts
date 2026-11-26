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
  runs: SummaryGroup<Run> | null;
  files: SummaryGroup<File> | null;
  /** The calls made on a connected integration, lookups included: a read on one is activity too. */
  integrationCalls: SummaryGroup<ConversationToolCall> | null;
}

/** The one chat tool that reaches an integration; every other tool acts on the platform. */
const INTEGRATION_CALL_TOOL = "call_integration_tool";

/** Whether a call acted on a connected integration, a lookup included. */
export function isIntegrationCall(call: ConversationToolCall): boolean {
  return call.toolName === INTEGRATION_CALL_TOOL;
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
  files,
}: SummaryInput<Run, File>): SummaryModel<Run, File> {
  const integrationCalls = calls.filter(isIntegrationCall).reverse();
  const fileRows = files?.rows.slice(0, SUMMARY_ROWS) ?? [];
  return {
    runs: counted(runs),
    files:
      files && fileRows.length > 0
        ? { rows: fileRows, more: files.hasMore || files.rows.length > fileRows.length }
        : null,
    integrationCalls: counted({ rows: integrationCalls, total: integrationCalls.length }),
  };
}
