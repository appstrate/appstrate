// SPDX-License-Identifier: Apache-2.0

/**
 * Preflight readiness check + browser handoff for `appstrate run`.
 *
 * Flow before the run is triggered:
 *   1. GET /api/agents/{scope}/{name}/readiness with the resolved
 *      connectionProfileId + per-provider overrides.
 *   2. If `ready` → continue silently.
 *   3. Else, in a TTY without `--json` / `--no-preflight`:
 *      - Print missing providers + reasons.
 *      - Prompt to open the browser at the agent-detail page with the
 *        `#connectors` anchor (`${instance}/agents/{scope}/{name}#connectors`)
 *        — same surface the dashboard's "Lancer" button uses, so the user
 *        lands on the agent's connectors panel scoped to this run.
 *      - Poll readiness every `pollMs` until ready or timeout. Ctrl-C
 *        aborts.
 *   4. Else (CI / non-TTY / `--json`) — emit a structured error on
 *      stderr (and stdout when `--json`) and exit 1.
 *
 * The browser opener is platform-aware: `open(1)` on macOS,
 * `xdg-open` on Linux, `cmd /c start` on Windows. Errors are
 * non-fatal (the user can copy-paste the URL).
 */

import { spawn } from "node:child_process";
import { confirm, spinner } from "../../lib/ui.ts";
import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";
import type { ReadinessProviderEntry, ReadinessReport } from "@appstrate/shared-types";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Backwards-compatible alias for callers that named the missing entry
 * type after the CLI's array name. Canonical type lives in
 * `@appstrate/shared-types`.
 */
export type ReadinessMissingEntry = ReadinessProviderEntry;
export type { ReadinessReport };

export class PreflightAbortError extends Error {
  constructor(
    public readonly code:
      | "connections_missing"
      | "preflight_timeout"
      | "preflight_failed"
      | "user_declined",
    message: string,
    public readonly report?: ReadinessReport,
    public readonly connectUrl?: string,
  ) {
    super(message);
    this.name = "PreflightAbortError";
  }
}

export interface PreflightInputs {
  instance: string;
  bearerToken: string;
  appId: string;
  orgId?: string;
  scope: string;
  name: string;
  connectionProfileId?: string;
  perProviderOverrides?: Record<string, string>;
  /** Fail fast in CI mode — never prompt, never poll. */
  json: boolean;
  /** When true, skip preflight entirely. */
  skip: boolean;
  /** Maximum wall-clock time for the polling loop. Default 5 min. */
  timeoutSeconds?: number;
  /** Test-only HTTP override. */
  fetchImpl?: typeof fetch;
  /** Test-only browser opener. */
  openBrowser?: (url: string) => void;
  /** Test-only confirm prompt — bypasses clack so tests don't read stdin. */
  confirmPrompt?: (message: string) => Promise<boolean>;
  /** Initial polling interval. Doubles each attempt up to `pollMaxMs`. Default 2s. */
  pollMs?: number;
  /** Upper bound on the polling interval after backoff. Default 20s. */
  pollMaxMs?: number;
  /** Test-only deterministic jitter source — return value in [0, 1). */
  randomJitter?: () => number;
}

export async function preflightCheck(inputs: PreflightInputs): Promise<ReadinessReport> {
  if (inputs.skip) {
    return { ready: true, missing: [] };
  }
  const fetchFn = inputs.fetchImpl ?? fetch;
  const open = inputs.openBrowser ?? defaultOpenBrowser;
  const confirmFn = inputs.confirmPrompt ?? ((msg) => confirm(msg, true));
  const timeoutMs = (inputs.timeoutSeconds ?? 300) * 1000;
  const pollInitialMs = inputs.pollMs ?? 2000;
  const pollMaxMs = inputs.pollMaxMs ?? 20000;
  const jitter = inputs.randomJitter ?? Math.random;
  const instance = normalizeInstance(inputs.instance);

  const fetchReadiness = async (): Promise<ReadinessReport> => {
    const url = buildReadinessUrl(instance, inputs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${inputs.bearerToken}`,
      "User-Agent": CLI_USER_AGENT,
      "X-App-Id": inputs.appId,
    };
    if (inputs.orgId) headers["X-Org-Id"] = inputs.orgId;
    const res = await fetchFn(url, { headers });
    if (!res.ok) {
      throw new PreflightAbortError(
        "preflight_failed",
        `Failed to fetch readiness: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as ReadinessReport;
  };

  const initial = await fetchReadiness();
  if (initial.ready) return initial;

  const connectUrl = buildConnectUrl(instance, inputs.scope, inputs.name);

  // Non-interactive paths exit immediately so CI runs fail fast with a
  // structured error the caller can parse.
  const isTty = process.stdin.isTTY === true;
  if (inputs.json || !isTty) {
    const error = new PreflightAbortError(
      "connections_missing",
      formatMissingMessage(initial.missing),
      initial,
      connectUrl,
    );
    if (inputs.json) {
      process.stdout.write(
        `${JSON.stringify({
          code: error.code,
          missing: initial.missing,
          connectUrl,
        })}\n`,
      );
    }
    throw error;
  }

  // Interactive — print summary, prompt, poll.
  process.stderr.write(`\n⚠ Missing connections:\n`);
  for (const entry of initial.missing) {
    process.stderr.write(`  - ${entry.providerId}: ${entry.message}\n`);
  }
  process.stderr.write(`\n  Connect: ${connectUrl}\n\n`);

  const ok = await confirmFn("Open browser to connect?");
  if (!ok) {
    throw new PreflightAbortError(
      "user_declined",
      "Aborted — required connections are still missing.",
      initial,
      connectUrl,
    );
  }
  try {
    open(connectUrl);
  } catch (err) {
    process.stderr.write(`warn: could not open browser automatically: ${getErrorMessage(err)}\n`);
    process.stderr.write(`  Copy this URL: ${connectUrl}\n`);
  }

  const sp = spinner();
  sp.start("Waiting for connections to be ready");
  const startedAt = Date.now();
  let attempt = 0;
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const wait = nextBackoffMs(pollInitialMs, pollMaxMs, attempt, jitter);
      const remaining = timeoutMs - (Date.now() - startedAt);
      await sleep(Math.min(wait, Math.max(0, remaining)));
      const report = await fetchReadiness();
      if (report.ready) {
        sp.stop("All required connections are ready.");
        return report;
      }
      attempt += 1;
    }
    sp.stop("Timed out waiting for connections.");
    throw new PreflightAbortError(
      "preflight_timeout",
      "Timed out waiting for connections to be ready.",
      undefined,
      connectUrl,
    );
  } catch (err) {
    sp.stop();
    throw err;
  }
}

/**
 * Capped exponential backoff with full jitter (AWS architecture blog).
 * Returns a wait time uniformly chosen in `[0, min(initialMs * 2^attempt,
 * maxMs)]`. A jittered backoff smooths the request rate the readiness
 * endpoint sees when many CLIs are waiting on a shared instance.
 */
export function nextBackoffMs(
  initialMs: number,
  maxMs: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, initialMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReadinessUrl(instance: string, inputs: PreflightInputs): string {
  const params = new URLSearchParams();
  if (inputs.connectionProfileId) {
    params.set("connectionProfileId", inputs.connectionProfileId);
  }
  for (const [providerId, profileId] of Object.entries(inputs.perProviderOverrides ?? {})) {
    params.set(`providerProfile.${providerId}`, profileId);
  }
  const qs = params.toString();
  // See bundle-fetch.ts:buildBundleUrl — `@` in scope must NOT be percent-encoded
  // or the Hono route `:scope{@[^/]+}` 404s on `%40scope`. scope/name are
  // already validated to a strict `[a-z0-9-]` charset.
  const base = `${instance}/api/agents/${inputs.scope}/${inputs.name}/readiness`;
  return qs ? `${base}?${qs}` : base;
}

/**
 * Build the same-origin connect URL the user is invited to open in
 * their browser — the agent-detail page with the `#connectors` anchor,
 * same surface the dashboard's "Lancer" button hands off to. We
 * construct it via `URL` against the normalized instance origin so a
 * malformed `instance` (or a future caller that forgets to normalise)
 * cannot produce a cross-origin redirect that `defaultOpenBrowser`
 * would faithfully launch.
 *
 * `assertSameOrigin` is a belt-and-suspenders guard: if the URL
 * constructor ever yielded a different origin (e.g. a proto-relative
 * `//evil.com` slipping through), we refuse rather than open it.
 */
function buildConnectUrl(instance: string, scope: string, name: string): string {
  const base = new URL(`/agents/${scope}/${name}`, instance);
  base.hash = "connectors";
  assertSameOrigin(base.toString(), instance);
  return base.toString();
}

export function assertSameOrigin(candidate: string, instance: string): void {
  let candidateOrigin: string;
  let instanceOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
    instanceOrigin = new URL(instance).origin;
  } catch {
    throw new PreflightAbortError(
      "preflight_failed",
      `Refusing to open browser: instance URL "${instance}" is not parseable.`,
    );
  }
  if (candidateOrigin !== instanceOrigin) {
    throw new PreflightAbortError(
      "preflight_failed",
      `Refusing to open browser: connect URL origin (${candidateOrigin}) differs from configured instance origin (${instanceOrigin}).`,
    );
  }
}

function formatMissingMessage(missing: ReadinessMissingEntry[]): string {
  const ids = missing.map((m) => m.providerId).join(", ");
  return `${missing.length} connection(s) missing: ${ids}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
  child.unref();
}
