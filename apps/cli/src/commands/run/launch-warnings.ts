// SPDX-License-Identifier: Apache-2.0

/**
 * The integration items a run launch answers with, rendered as one line each:
 * the `warnings` of a 201 (`integration_unbound`: the run started without a
 * declared, non-required integration) and the `errors` of a 409
 * `missing_integration_connection` (the launch was refused). Shared by the
 * `--remote` trigger and the `--report` registration, which hit different
 * routes with the same item shape.
 */

/** `<integration>: <message> (<code>)` per well-formed item; anything else is skipped. */
export function launchItemLines(items: unknown): string[] {
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

/**
 * The `--json` line announcing a launched run (`appstrate.remote.triggered` for `--remote`,
 * `appstrate.report.started` for `--report`); `warnings` only when the launch reported some.
 */
export function launchEnvelope(
  type: "appstrate.remote.triggered" | "appstrate.report.started",
  runId: string,
  instance: string,
  warnings: unknown[],
): string {
  const envelope = { type, runId, instance, ...(warnings.length > 0 ? { warnings } : {}) };
  return JSON.stringify(envelope) + "\n";
}

/**
 * The items of a 409 `missing_integration_connection`, joined for an error
 * hint, or null for any other body (the caller then shows it raw).
 */
export function connectionRefusalSummary(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const { code, errors } = body as { code?: unknown; errors?: unknown };
  if (code !== "missing_integration_connection") return null;
  const lines = launchItemLines(errors);
  return lines.length > 0 ? lines.join("; ") : null;
}
