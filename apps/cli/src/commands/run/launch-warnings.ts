// SPDX-License-Identifier: Apache-2.0

// A launch's integration items (a 201's `warnings`, a 409's `errors`), one line each — shared
// by `--remote` and `--report`, whose routes answer the same item shape.

/** `<integration>: <message> (<code>)` per well-formed item; anything else is skipped. */
function launchItemLines(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const lines: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const { field, code, message } = item as Record<string, unknown>;
    if (typeof code !== "string") continue;
    const subject = typeof field === "string" ? field.replace(/^integrations\./, "") : "run";
    const text = typeof message === "string" && message.length > 0 ? message : code;
    lines.push(`${subject}: ${text} (${code})`);
  }
  return lines;
}

export interface LaunchAnnouncement {
  type: "appstrate.remote.triggered" | "appstrate.report.started";
  json?: boolean | undefined;
  bundleLabel: string;
  instance: string;
  /** The platform run, or null for a local run nothing reports to. */
  run: { runId: string; warnings: unknown[] } | null;
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
  for (const line of launchItemLines(a.run?.warnings)) a.writeStderr(`⚠ ${line}\n`);
}

/** A 409 `missing_integration_connection`'s items, one line each, or null for any other body. */
export function connectionRefusalLines(body: unknown): string[] | null {
  if (body === null || typeof body !== "object") return null;
  const { code, errors } = body as { code?: unknown; errors?: unknown };
  if (code !== "missing_integration_connection") return null;
  const lines = launchItemLines(errors);
  return lines.length > 0 ? lines : null;
}
