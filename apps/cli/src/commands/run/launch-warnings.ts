// SPDX-License-Identifier: Apache-2.0

// A launch's integration items (a 201's `warnings`, a 409's `errors`), one line each — shared
// by `--remote` and `--report`, whose routes answer the same item shape.

import {
  CONNECTION_RESOLUTION_SOURCES,
  CONNECTION_RESOLUTION_WARNING_CODES,
  type ConnectionResolutionSource,
  type ConnectionResolutionWarningCode,
} from "@appstrate/core/integration";

/** One item of a launch response; the wire's other fields ride along untouched. */
interface LaunchItem {
  field?: string;
  code: string;
  message?: string;
  source?: ConnectionResolutionSource;
}

/** A `warnings[]` item: an integration the run starts without. */
export interface LaunchWarning extends LaunchItem {
  field: string;
  code: ConnectionResolutionWarningCode;
}

const isIn = <T extends string>(values: readonly T[], value: unknown): value is T =>
  values.includes(value as T);

/** The well-formed items of a launch response array; anything else is dropped. */
function launchItems(items: unknown): LaunchItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is LaunchItem => {
    if (item === null || typeof item !== "object") return false;
    const { field, code, message, source } = item as Record<string, unknown>;
    return (
      typeof code === "string" &&
      (field === undefined || typeof field === "string") &&
      (message === undefined || typeof message === "string") &&
      (source === undefined || isIn(CONNECTION_RESOLUTION_SOURCES, source))
    );
  });
}

/** A launch response's `warnings`, parsed once at the boundary. */
export function parseLaunchWarnings(items: unknown): LaunchWarning[] {
  return launchItems(items).filter(
    (item): item is LaunchWarning =>
      item.field !== undefined && isIn(CONNECTION_RESOLUTION_WARNING_CODES, item.code),
  );
}

/** `<integration>: <message> (<code> via <source>)` per item. */
function launchItemLines(items: readonly LaunchItem[]): string[] {
  return items.map(({ field, code, message, source }) => {
    const subject = field?.replace(/^integrations\./, "") ?? "run";
    const text = message || code;
    return `${subject}: ${text} (${code}${source ? ` via ${source}` : ""})`;
  });
}

export interface LaunchAnnouncement {
  type: "appstrate.remote.triggered" | "appstrate.report.started";
  json?: boolean | undefined;
  bundleLabel: string;
  instance: string;
  /** The platform run, or null for a local run nothing reports to. */
  run: { runId: string; warnings: readonly LaunchWarning[] } | null;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
}

/** `→ running …` and a `⚠` line per warning on stderr, or under `--json` the envelope on stdout. */
export function announceLaunch(a: LaunchAnnouncement): void {
  if (a.json) {
    if (!a.run) return;
    const { runId, warnings } = a.run;
    const envelope = { type: a.type, runId, instance: a.instance };
    const line = warnings.length > 0 ? { ...envelope, warnings } : envelope;
    a.writeStdout(JSON.stringify(line) + "\n");
    return;
  }
  const reportNote = a.run ? ` (reporting to ${a.instance} as ${a.run.runId})` : "";
  a.writeStderr(`→ running ${a.bundleLabel}${reportNote}\n`);
  for (const line of launchItemLines(a.run?.warnings ?? [])) a.writeStderr(`⚠ ${line}\n`);
}

/** A 409 `missing_integration_connection`'s items, one line each, or null for any other body. */
export function connectionRefusalLines(body: unknown): string[] | null {
  if (body === null || typeof body !== "object") return null;
  const { code, errors } = body as { code?: unknown; errors?: unknown };
  if (code !== "missing_integration_connection") return null;
  const lines = launchItemLines(launchItems(errors));
  return lines.length > 0 ? lines : null;
}
