// SPDX-License-Identifier: Apache-2.0

/**
 * Execution mode resolution for `appstrate run`.
 *
 * Two modes:
 *
 * - `remote` — the pinned Appstrate instance executes the run inside its
 *   own Docker container (same path as the dashboard "Run" button). The
 *   CLI POSTs to `/api/agents/:scope/:name/run`, then tails events via
 *   the realtime SSE endpoint.
 *
 * - `local` — the bundle runs in-process via PiRunner with the caller's
 *   shell, FS, and env. Best for the dev-loop on a bundle you authored:
 *   sub-second feedback, `--snapshot` replays, planting in your debugger.
 *
 * Default rule (no flag): `target.kind === "id"` → remote, `path` → local.
 * Rationale: `./bundle.afps` is "this file I just built" (local makes
 * sense). `@scope/agent` is "the published agent the platform knows
 * about" (remote matches dashboard parity and isolates third-party code
 * from the user's shell). See PR description for the full tradeoff.
 *
 * Overrides:
 *
 * - `--local`  → force local. Works for both `id` (dev-loop on a
 *   published agent) and `path` (no-op since path defaults to local).
 * - `--remote` → force remote. With `path` mode the CLI rejects (v1
 *   does not upload local bundles to inline runs — would be silently
 *   different execution; explicit refusal is clearer than half-magic).
 *
 * `--local` and `--remote` are mutually exclusive.
 */

import type { parseRunTarget } from "./package-spec.ts";

export type ExecutionMode = "local" | "remote";

export type RunTarget = ReturnType<typeof parseRunTarget>;

/** Subset of RunCommandOptions consumed by mode resolution + validation. */
export interface ModeResolutionOpts {
  local?: boolean;
  remote?: boolean;
  // Local-only flags — flagged at validation time when in remote mode.
  snapshot?: string;
  credsFile?: string;
  llmApiKey?: string;
  modelApi?: string;
  modelSource?: string;
  providers?: string;
  report?: string;
  reportFallback?: string;
  sinkTtl?: number;
  noPreflight?: boolean;
  preflightTimeout?: number;
  connectionProfile?: string;
  providerProfile?: string[];
}

export class ExecutionModeError extends Error {
  override readonly name = "ExecutionModeError";
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    if (hint !== undefined) this.hint = hint;
  }
}

/**
 * Resolve the execution mode from the parsed target + opts.
 *
 * Throws `ExecutionModeError` only on flag conflicts (`--local --remote`)
 * or when `--remote` is paired with a path target. Default-mode resolution
 * never throws — it picks based on `target.kind`.
 */
export function resolveExecutionMode(target: RunTarget, opts: ModeResolutionOpts): ExecutionMode {
  if (opts.local && opts.remote) {
    throw new ExecutionModeError(
      "--local and --remote are mutually exclusive",
      "Drop one of the two flags.",
    );
  }

  if (opts.local) return "local";

  if (opts.remote) {
    if (target.kind === "path") {
      throw new ExecutionModeError(
        "--remote does not support local bundle paths",
        "Pass an `@scope/agent` id, or omit --remote to keep the local default for path-mode.",
      );
    }
    return "remote";
  }

  // No explicit flag — default by target kind.
  return target.kind === "id" ? "remote" : "local";
}

/**
 * Validate that the user-supplied flags are compatible with the resolved
 * execution mode. Local-only flags are rejected in remote mode with a
 * clear hint pointing at `--local` as the opt-in.
 *
 * Kept separate from `resolveExecutionMode` so the dispatch can branch
 * on mode FIRST (allows the local path to call this and ignore remote-
 * only checks symmetrically — currently there are no remote-only flags).
 */
export function validateOptsForMode(mode: ExecutionMode, opts: ModeResolutionOpts): void {
  if (mode === "local") return;

  // Remote mode — surface anything that only makes sense locally.
  // `--report*` and `--sink-ttl` are tied to the **local-execution**
  // observability path (HMAC sink → `/api/runs/remote`); a server-
  // executed run reports natively, so these flags are silently ignored
  // by the trigger. Reject so the user understands they have no effect.
  const offenders: { flag: string; reason: string }[] = [];

  if (opts.snapshot !== undefined) {
    offenders.push({
      flag: "--snapshot",
      reason: "snapshot replay seeds the local ExecutionContext only",
    });
  }
  if (opts.credsFile !== undefined) {
    offenders.push({
      flag: "--creds-file",
      reason: "local credentials are read by the in-process resolver only",
    });
  }
  if (opts.llmApiKey !== undefined) {
    offenders.push({
      flag: "--llm-api-key",
      reason: "the server uses its own pinned LLM credentials",
    });
  }
  if (opts.modelApi !== undefined) {
    offenders.push({
      flag: "--model-api",
      reason: "the server resolves the API from the model preset",
    });
  }
  if (opts.modelSource !== undefined) {
    offenders.push({
      flag: "--model-source",
      reason: "the server always uses the preset path for remote runs",
    });
  }
  if (opts.providers !== undefined && opts.providers !== "remote") {
    offenders.push({
      flag: `--providers=${opts.providers}`,
      reason: "remote runs always resolve providers via the platform",
    });
  }
  if (opts.report !== undefined) {
    offenders.push({
      flag: "--report",
      reason: "remote runs are reported natively — no client sink to configure",
    });
  }
  if (opts.reportFallback !== undefined) {
    offenders.push({
      flag: "--report-fallback",
      reason: "remote runs are reported natively — no client sink to configure",
    });
  }
  if (opts.sinkTtl !== undefined) {
    offenders.push({
      flag: "--sink-ttl",
      reason: "remote runs are reported natively — no client sink to configure",
    });
  }
  if (opts.noPreflight === true) {
    offenders.push({
      flag: "--no-preflight",
      reason: "the server runs its own preflight before launching the container",
    });
  }
  if (opts.preflightTimeout !== undefined) {
    offenders.push({
      flag: "--preflight-timeout",
      reason: "the server runs its own preflight before launching the container",
    });
  }
  if (opts.connectionProfile !== undefined) {
    offenders.push({
      flag: "--connection-profile",
      reason:
        "remote runs use the application's pinned profiles — change them via the dashboard or `appstrate connections profile switch`",
    });
  }
  if (opts.providerProfile !== undefined && opts.providerProfile.length > 0) {
    offenders.push({
      flag: "--provider-profile",
      reason: "per-provider overrides are not yet accepted by the run trigger endpoint",
    });
  }

  if (offenders.length === 0) return;

  const list = offenders.map((o) => `  ${o.flag} — ${o.reason}`).join("\n");
  throw new ExecutionModeError(
    `The following flags are not supported in remote execution mode:\n${list}`,
    "Pass --local to opt into in-process execution, or drop these flags.",
  );
}
