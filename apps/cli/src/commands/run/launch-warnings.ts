// SPDX-License-Identifier: Apache-2.0

// A launch's integration items (a 201's `warnings`, a 409's `errors`), one line each — shared
// by `--remote` and `--report`, whose routes answer the same item shape.

/** Codes and sources stay open strings: a newer server may send ones this CLI does not know. */
export interface LaunchItem {
  field?: string;
  code: string;
  message?: string;
  source?: string;
  /** On a `must_choose_connection` item; read item by item in {@link candidateLines}. */
  candidate_connections?: unknown;
}

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

/** A launch response's `warnings` / `errors`; items without a code are dropped. */
export function parseLaunchItems(items: unknown): LaunchItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is LaunchItem => {
    if (item === null || typeof item !== "object") return false;
    const { field, code, message, source } = item as Record<string, unknown>;
    return (
      typeof code === "string" &&
      optionalString(field) &&
      optionalString(message) &&
      optionalString(source)
    );
  });
}

/** `integrations.<id>` → `<id>`; undefined for a run-level item. */
const integrationOf = (field: string | undefined): string | undefined =>
  field?.startsWith("integrations.") ? field.slice("integrations.".length) : undefined;

/** `<integration>: <message> (<code> via <source>)`. */
function launchItemLine({ field, code, message, source }: LaunchItem): string {
  const subject = integrationOf(field) ?? field ?? "run";
  const text = message || code;
  return `${subject}: ${text} (${code}${source ? ` via ${source}` : ""})`;
}

/**
 * The connections an item offers to choose from, one indented line each:
 * `<label> (<account id>, yours|shared[, needs reconnection]): --connection <integration>=<id>`.
 * A candidate without an id is dropped — there is nothing to pass.
 */
function candidateLines({ field, candidate_connections: candidates }: LaunchItem): string[] {
  const integration = integrationOf(field);
  if (!integration || !Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const { id, label, account_id, owned_by_actor, needs_reconnection } = candidate as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || id.length === 0) return [];
    const traits = [
      ...(typeof account_id === "string" ? [account_id] : []),
      ...(typeof owned_by_actor === "boolean" ? [owned_by_actor ? "yours" : "shared"] : []),
      ...(needs_reconnection === true ? ["needs reconnection"] : []),
    ];
    const name = typeof label === "string" && label.length > 0 ? label : id;
    const detail = traits.length > 0 ? ` (${traits.join(", ")})` : "";
    return [`  ${name}${detail}: --connection ${integration}=${id}`];
  });
}

export interface LaunchAnnouncement {
  type: "appstrate.remote.triggered" | "appstrate.report.started";
  json?: boolean | undefined;
  bundleLabel: string;
  instance: string;
  /** The platform run, or null for a local run nothing reports to. */
  run: { runId: string; warnings: readonly LaunchItem[] } | null;
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
  for (const item of a.run?.warnings ?? []) a.writeStderr(`⚠ ${launchItemLine(item)}\n`);
}

/**
 * A 409 `missing_integration_connection`'s items, one line each, a `must_choose_connection`
 * item followed by its candidates; null for any other body.
 */
export function connectionRefusalLines(body: unknown): string[] | null {
  if (body === null || typeof body !== "object") return null;
  const { code, errors } = body as { code?: unknown; errors?: unknown };
  if (code !== "missing_integration_connection") return null;
  const lines = parseLaunchItems(errors).flatMap((item) => [
    launchItemLine(item),
    ...candidateLines(item),
  ]);
  return lines.length > 0 ? lines : null;
}
