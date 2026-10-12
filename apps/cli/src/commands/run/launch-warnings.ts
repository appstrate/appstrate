// SPDX-License-Identifier: Apache-2.0

// A launch's integration items (a 201's `warnings`, a 409's `errors`), one line each — shared
// by `--remote` and `--report`, whose routes answer the same item shape.

/** One of a `must_choose_connection` item's `candidate_connections`, as the API sends it. */
interface LaunchCandidate {
  id: string;
  label: string;
  account_id: string;
  owned_by_actor: boolean;
  needs_reconnection: boolean;
}

/** Codes and sources stay open strings: a newer server may send ones this CLI does not know. */
export interface LaunchItem {
  field?: string;
  code: string;
  message?: string;
  source?: string;
  candidate_connections?: LaunchCandidate[];
}

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

function isCandidate(value: unknown): value is LaunchCandidate {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.account_id === "string" &&
    typeof candidate.owned_by_actor === "boolean" &&
    typeof candidate.needs_reconnection === "boolean"
  );
}

/**
 * A launch response's `warnings` / `errors`; items without a code are dropped, and a candidate
 * outside the contract is dropped alone, its item kept.
 */
export function parseLaunchItems(items: unknown): LaunchItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): LaunchItem[] => {
    if (item === null || typeof item !== "object") return [];
    const {
      field,
      code,
      message,
      source,
      candidate_connections: candidates,
    } = item as Record<string, unknown>;
    if (
      typeof code !== "string" ||
      !optionalString(field) ||
      !optionalString(message) ||
      !optionalString(source)
    ) {
      return [];
    }
    if (candidates === undefined) return [item as LaunchItem];
    const valid = Array.isArray(candidates) ? candidates.filter(isCandidate) : [];
    return [{ ...(item as LaunchItem), candidate_connections: valid }];
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

/** One indented line per candidate: label, account, owner, state, then the flag that names it. Shared by refusals and warnings. */
function candidateLines(item: LaunchItem): string[] {
  const integration = integrationOf(item.field);
  if (!integration) return [];
  return (item.candidate_connections ?? []).map((candidate) => {
    const traits = [
      candidate.account_id,
      candidate.owned_by_actor ? "yours" : "shared",
      ...(candidate.needs_reconnection ? ["needs reconnection"] : []),
    ];
    const flag = `--connection ${integration}=${candidate.id}`;
    return `  ${candidate.label} (${traits.join(", ")}): ${flag}`;
  });
}

export interface LaunchAnnouncement {
  type: "appstrate.remote.triggered" | "appstrate.report.started";
  json?: boolean | undefined;
  bundleLabel: string;
  instance: string;
  /** The platform run, or null for a local run nothing reports to. */
  run: { runId: string; warnings: readonly LaunchItem[] } | null;
  /**
   * `{ns}__api_call` tools of a locally executed run that call the instance's credential proxy
   * (`--integrations remote`). With no `run` to name, their calls are made outside a run.
   */
  proxyTools?: number | undefined;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
}

/** What a credential-proxy call made outside a run requires and reaches, and what changes it. */
const outsideRunLines = (instance: string): string[] => [
  `⚠ no run registered on ${instance}: integration calls reach its credential proxy outside a run`,
  "  they need the credential-proxy:direct permission and reach your own connections only (list: appstrate api GET /api/credential-proxy/connections)",
  "  with --report they go through the registered run instead (credential-proxy:call, the connections the run binds)",
];

/**
 * `→ running …` and a `⚠` line per warning, its candidates under it, on stderr; with no run and
 * `proxyTools`, what their calls require outside a run. Under `--json` the envelope on stdout.
 */
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
  if (!a.run && (a.proxyTools ?? 0) > 0) {
    for (const line of outsideRunLines(a.instance)) a.writeStderr(`${line}\n`);
  }
  for (const item of a.run?.warnings ?? []) {
    a.writeStderr(`⚠ ${launchItemLine(item)}\n`);
    for (const line of candidateLines(item)) a.writeStderr(`${line}\n`);
  }
}

/** A 409 `missing_integration_connection`'s items, each above its candidates; else null. */
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
