// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_AUTH_HEADER, type IntegrationBootReport } from "@appstrate/core/sidecar-types";

/**
 * Cap on how long we wait for the sidecar's boot report. Generous: it
 * exceeds the sidecar's per-connection MCP connect deadline (30 s) plus
 * headroom for a few sequential connections, so a report that never
 * arrives means an integration boot genuinely hung — which we treat as a
 * fatal "did not start as declared", not a transient blip.
 */
const BOOT_REPORT_DEADLINE_MS = 60_000;

/**
 * Fetch the sidecar's integration boot report — the authoritative spawn/
 * connect outcome for every declared integration, plus the per-phase
 * breadcrumbs the dashboard renders. The endpoint awaits the sidecar's boot
 * pass before answering, so a successful response is final — and it is the
 * ONLY sidecar call that does: `/mcp` waits for the boot too, but gives up
 * after a fixed cap and answers `tools/list` without the integrations still
 * booting. The entrypoint therefore reads this report BEFORE listing tools.
 *
 * Reachable on the same per-run network the MCP client just handshook over;
 * a connection-level failure here is almost always a momentary race, so we
 * retry briefly. We do NOT swallow a definitive failure: the run must abort
 * when integration health can't be confirmed (the platform contract — an
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
): Promise<{ report: IntegrationBootReport } | { error: string }> {
  const url = `${sidecarUrl.replace(/\/$/, "")}/integrations/boot-report`;
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), BOOT_REPORT_DEADLINE_MS);
    try {
      const res = await fetchFn(url, {
        signal: ac.signal,
        headers: { [SIDECAR_AUTH_HEADER]: authToken },
      });
      if (res.ok) return { report: (await res.json()) as IntegrationBootReport };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = getErrorMessage(err);
    } finally {
      clearTimeout(timer);
    }
    process.stderr.write(`[boot-report] ${lastError} (attempt ${attempt}/3)\n`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  return { error: lastError };
}
