// SPDX-License-Identifier: Apache-2.0

// Log types and pure utility functions shared between log-viewer components and pages.

import { asProviderCallBody, type ProviderCallBody } from "./provider-call-body-utils";

export interface LogEntry {
  message: string;
  type: string;
  level?: string;
  detail?: string;
  createdAt?: Date | string | null;
  /**
   * Optional structured provider call response body — when set, log
   * viewers SHOULD render it via `<ProviderCallBody>` instead of (or
   * in addition to) the textual `detail`.
   */
  providerCallBody?: ProviderCallBody;
}

/**
 * Sniff a log payload for a provider call response body. Recognises
 * either:
 *   1. The full tool result envelope: `{ status, headers, body: {...} }`
 *      (matches what `<provider>_call` tools serialise to JSON)
 *   2. A bare `body: {...}` field
 * Returns `null` when no recognisable shape is present.
 */
export function extractProviderCallBody(
  data: Record<string, unknown> | null | undefined,
): ProviderCallBody | null {
  if (!data) return null;
  const direct = asProviderCallBody(data.body);
  if (direct) return direct;
  return asProviderCallBody(data);
}

export interface RawLog {
  type: string;
  level: string;
  event?: string | null;
  message?: string | null;
  data?: Record<string, unknown> | null;
  createdAt?: Date | string | null;
}

export function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${str}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
}

/**
 * Transform raw run logs into LogEntry[], merging consecutive text-only
 * progress entries and extracting structured output data.
 */
export function buildLogEntries(rawLogs: RawLog[]): {
  entries: LogEntry[];
  output: Record<string, unknown> | null;
  report: string | null;
} {
  const entries: LogEntry[] = [];
  let output: Record<string, unknown> | null = null;
  let report: string | null = null;
  let lastWasPlainText = false;

  for (const log of rawLogs) {
    if (log.event === "output" && log.data) {
      if (!output) output = {};
      Object.assign(output, log.data);
      lastWasPlainText = false;
    } else if (log.event === "report" && log.data) {
      const content = (log.data as { content?: string }).content;
      if (content) {
        report = report ? report + "\n\n" + content : content;
      }
      lastWasPlainText = false;
    } else if (log.event === "run_completed") {
      lastWasPlainText = false;
    } else {
      const logData = (log.data ?? {}) as Record<string, unknown>;
      const message = (logData.message as string) || log.message || "";
      if (message) {
        const args = logData.args as Record<string, unknown> | undefined;
        const detail = args ? formatToolArgs(args) : undefined;
        const isPlainText = log.type === "progress" && !log.data;
        const providerCallBody = extractProviderCallBody(logData) ?? undefined;

        if (isPlainText && lastWasPlainText && entries.length > 0) {
          entries[entries.length - 1]!.message += "\n" + message;
        } else {
          entries.push({
            message,
            type: log.type || "progress",
            level: log.level || "debug",
            detail,
            createdAt: log.createdAt,
            providerCallBody,
          });
        }
        lastWasPlainText = isPlainText;
      }
    }
  }

  return { entries, output, report };
}

export function formatTimestamp(d: Date | string | null | undefined, lang: string): string {
  if (!d) return "\u2014";
  try {
    const date = d instanceof Date ? d : new Date(d);
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const hms = date.toLocaleTimeString(lang, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `${hms}.${ms}`;
  } catch {
    return "\u2014";
  }
}

/** Text color by semantic type (nature of the log). */
export const typeColors: Record<string, string> = {
  system: "text-primary",
};

/** Text color by severity level (overrides type color when set). */
export const levelColors: Record<string, string> = {
  warn: "text-amber-400",
  error: "text-destructive",
};
