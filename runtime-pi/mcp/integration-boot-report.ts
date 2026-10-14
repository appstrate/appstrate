// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_AUTH_HEADER, type IntegrationBootReport } from "@appstrate/core/sidecar-types";

/**
 * The one deadline on the boot report, every attempt included: one wave of
 * `INTEGRATION_BOOT_CONCURRENCY` connections costs at worst a docker exec
 * (60 s) plus an MCP connect (30 s), and 16 connections measured ~30 s in
 * production even booted one at a time. A report still missing by then means
 * an integration boot genuinely hung, which fails the run as "did not start
 * as declared", not as a transient blip.
 */
const BOOT_REPORT_DEADLINE_MS = 120_000;
const RETRY_DELAY_CAP_MS = 2_000;

/**
 * Fetch the sidecar's integration boot report — the authoritative spawn/
 * connect outcome for every declared integration, plus the per-phase
 * breadcrumbs the dashboard renders. The endpoint awaits the sidecar's boot
 * pass before answering, so a successful response is final — and it is the
 * ONLY sidecar call that does: `/mcp` serves without waiting for the boot and
 * answers `tools/list` without the integrations still booting. The entrypoint
 * therefore reads this report BEFORE listing tools.
 *
 * Reachable on the same per-run network the MCP client just handshook over.
 * Only a transport failure (the request never reached a listener) is retried,
 * until the deadline; a deadline abort, an HTTP error or an unreadable body
 * is final. We do NOT swallow a definitive failure: the run must abort when
 * integration health can't be confirmed (the platform contract — an
 * integration that didn't launch as declared fails the run, every tier).
 *
 * Authenticated like every other sidecar call, with the run's
 * `SIDECAR_AUTH_HEADER` token. Still no RUN token: the agent remains unable to
 * call the PLATFORM back — this header only says "I am the agent container" to
 * the sidecar that already knows the answer.
 */
export async function fetchIntegrationBootReport(
  sidecarUrl: string,
  authToken: string,
  fetchFn: typeof fetch = fetch,
  log: (line: string) => void = (line) => process.stderr.write(line),
): Promise<{ report: IntegrationBootReport } | { error: string }> {
  const url = `${sidecarUrl.replace(/\/$/, "")}/integrations/boot-report`;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), BOOT_REPORT_DEADLINE_MS);
  const deadlineError = `no boot report within ${BOOT_REPORT_DEADLINE_MS / 1000} s`;
  try {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          signal: ac.signal,
          headers: { [SIDECAR_AUTH_HEADER]: authToken },
        });
      } catch (err) {
        if (ac.signal.aborted) return { error: deadlineError };
        log(`[boot-report] ${getErrorMessage(err)} (attempt ${attempt})\n`);
        await new Promise((r) => setTimeout(r, Math.min(250 * attempt, RETRY_DELAY_CAP_MS)));
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      try {
        return { report: (await res.json()) as IntegrationBootReport };
      } catch (err) {
        return { error: ac.signal.aborted ? deadlineError : getErrorMessage(err) };
      }
    }
  } finally {
    clearTimeout(deadline);
  }
}
