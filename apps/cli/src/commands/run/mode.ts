// SPDX-License-Identifier: Apache-2.0

/**
 * Execution mode resolution for `appstrate run`.
 *
 * Three modes:
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
 * - `command` — `appstrate run @scope/agent -- <command> [args…]`: no agent
 *   executes. The CLI registers an ordinary remote run of the agent and is
 *   its runner, and what runs under it is the command, which reaches the
 *   connections the run bound through the credential proxy (`X-Run-Id`).
 *   Resolved by the presence of a command, never by a flag.
 *
 * Default rule (no flag, no command): `target.kind === "id"` → remote,
 * `path` → local.
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
 * `--local` and `--remote` are mutually exclusive, and both are refused
 * with a command.
 */

import type { parseRunTarget } from "./package-spec.ts";

export type ExecutionMode = "local" | "remote" | "command";

type RunTarget = ReturnType<typeof parseRunTarget>;

/** Subset of RunCommandOptions consumed by mode resolution + validation. */
interface ModeResolutionOpts {
  local?: boolean;
  remote?: boolean;
  /** Everything after the first `--`; undefined when the invocation has none. */
  command?: readonly string[] | undefined;
  // Local-only flags — flagged at validation time when in remote mode.
  snapshot?: string;
  credsFile?: string;
  llmApiKey?: string;
  modelApi?: string;
  modelSource?: string;
  integrations?: string;
  report?: string;
  reportFallback?: string;
  sinkTtl?: number;
  // Remote-only flag — flagged at validation time when in local mode.
  cancelOnExit?: boolean | undefined;
  // Accepted by both agent-executing modes — flagged in command mode only.
  model?: string;
  output?: string;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  proxy?: string;
  noInherit?: boolean;
  runId?: string;
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
 * The command of `appstrate run … -- <command> [args…]`: everything after the
 * first literal `--` of the raw arguments, or undefined when there is none.
 * Read off `argv` because commander drops that separator before the `run`
 * action sees its operands, leaving `run @a/b x` and `run @a/b -- x` alike.
 */
export function commandAfterSeparator(argv: readonly string[]): string[] | undefined {
  const at = argv.indexOf("--");
  return at === -1 ? undefined : argv.slice(at + 1);
}

/**
 * Resolve the execution mode from the parsed target + opts.
 *
 * Throws `ExecutionModeError` only on flag conflicts (`--local --remote`),
 * when `--remote` is paired with a path target, or when a command is given
 * something it cannot run under. Default-mode resolution never throws — it
 * picks based on `target.kind`.
 */
export function resolveExecutionMode(target: RunTarget, opts: ModeResolutionOpts): ExecutionMode {
  if (opts.command !== undefined) return resolveCommandMode(target, opts);

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

/** Command mode: the target is an agent of the instance, and no flag picks where an agent executes. */
function resolveCommandMode(target: RunTarget, opts: ModeResolutionOpts): ExecutionMode {
  if (opts.command?.length === 0) {
    throw new ExecutionModeError(
      "`--` is followed by no command",
      "Write the command after it: appstrate run @scope/agent -- <command> [args…]",
    );
  }
  if (target.kind === "path") {
    throw new ExecutionModeError(
      "A command runs under an agent registered on the instance, not a local bundle path",
      "Pass an `@scope/agent` id before the `--`.",
    );
  }
  const flag = opts.local ? "--local" : opts.remote ? "--remote" : null;
  if (flag) {
    throw new ExecutionModeError(
      `${flag} selects where the agent executes, and a command replaces that execution`,
      `Drop ${flag}, or drop the \`-- <command>\` to run the agent itself.`,
    );
  }
  return "command";
}

const NO_AGENT_EXECUTES = "no agent executes, so no model is called";
const PROXY_ONLY = "the command reaches connections through the instance's credential proxy only";
const NOTHING_TO_RENDER = "the CLI renders no agent event: the output is the command's own";

/**
 * Flags a command run has nothing to act on, by the option that carries each.
 * `--cancel-on-exit` is told apart from its negation in `commandModeOffenders`.
 */
const COMMAND_MODE_REFUSALS: ReadonlyArray<{
  option: keyof ModeResolutionOpts;
  flag: string;
  reason: string;
}> = [
  {
    option: "snapshot",
    flag: "--snapshot",
    reason: "snapshot replay seeds an agent's ExecutionContext, and no agent executes",
  },
  { option: "credsFile", flag: "--creds-file", reason: PROXY_ONLY },
  { option: "integrations", flag: "--integrations", reason: PROXY_ONLY },
  { option: "llmApiKey", flag: "--llm-api-key", reason: NO_AGENT_EXECUTES },
  { option: "model", flag: "--model", reason: NO_AGENT_EXECUTES },
  { option: "modelApi", flag: "--model-api", reason: NO_AGENT_EXECUTES },
  { option: "modelSource", flag: "--model-source", reason: NO_AGENT_EXECUTES },
  {
    option: "report",
    flag: "--report",
    reason: "the run is always registered on the instance: it is what the command's calls name",
  },
  {
    option: "reportFallback",
    flag: "--report-fallback",
    reason: "a refused registration ends the command: there is no console-only run to fall back to",
  },
  {
    option: "output",
    flag: "--output",
    reason: "a command produces no RunResult; redirect its stdout instead",
  },
  { option: "json", flag: "--json", reason: NOTHING_TO_RENDER },
  { option: "verbose", flag: "--verbose", reason: NOTHING_TO_RENDER },
  { option: "quiet", flag: "--quiet", reason: NOTHING_TO_RENDER },
  {
    option: "proxy",
    flag: "--proxy",
    reason: "the command's outbound traffic is its own; the run records no proxy",
  },
  {
    option: "noInherit",
    flag: "--no-inherit",
    reason: "the per-space run-config (model, proxy) is not read",
  },
  {
    option: "runId",
    flag: "--run-id",
    reason: "the instance assigns the run id; the command reads it from APPSTRATE_RUN_ID",
  },
];

function commandModeOffenders(opts: ModeResolutionOpts): { flag: string; reason: string }[] {
  const offenders = COMMAND_MODE_REFUSALS.filter(({ option }) => {
    const value = opts[option];
    return value !== undefined && value !== false;
  }).map(({ flag, reason }) => ({ flag, reason }));
  if (opts.cancelOnExit !== undefined) {
    offenders.push({
      flag: opts.cancelOnExit ? "--cancel-on-exit" : "--no-cancel-on-exit",
      reason: "the run ends with the command: a signal always stops both",
    });
  }
  return offenders;
}

/**
 * Validate that the user-supplied flags are compatible with the resolved
 * execution mode. Local-only flags are rejected in remote mode with a
 * clear hint pointing at `--local` as the opt-in, and symmetrically for
 * remote-only flags in local mode. Command mode refuses every flag that
 * configures an agent's execution or its rendering.
 *
 * Kept separate from `resolveExecutionMode` so the dispatch can branch
 * on mode FIRST.
 */
export function validateOptsForMode(mode: ExecutionMode, opts: ModeResolutionOpts): void {
  if (mode === "command") {
    throwOffenders(
      commandModeOffenders(opts),
      "command",
      "Drop these flags, or drop the `-- <command>` to run the agent itself.",
    );
    return;
  }

  if (mode === "local") {
    // `--cancel-on-exit` decides what a signal does to a PLATFORM-side
    // run. A local run executes in this very process — it dies with the
    // CLI no matter what — so the flag has nothing to act on. Reject
    // rather than accept-and-ignore, same contract as the remote branch.
    if (opts.cancelOnExit !== undefined) {
      const flag = opts.cancelOnExit ? "--cancel-on-exit" : "--no-cancel-on-exit";
      throw new ExecutionModeError(
        `The following flags are not supported in local execution mode:\n` +
          `  ${flag} — the in-process runner dies with the CLI; there is no platform-side run to keep alive`,
        "Drop the flag, or pass --remote to run the agent on the pinned instance.",
      );
    }
    return;
  }

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
  if (opts.integrations !== undefined && opts.integrations !== "remote") {
    offenders.push({
      flag: `--integrations=${opts.integrations}`,
      reason: "remote runs always resolve integrations via the platform",
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

  throwOffenders(
    offenders,
    "remote",
    "Pass --local to opt into in-process execution, or drop these flags.",
  );
}

/** One line per offender, so the user fixes them in one pass; silent when there is none. */
function throwOffenders(
  offenders: readonly { flag: string; reason: string }[],
  mode: ExecutionMode,
  hint: string,
): void {
  if (offenders.length === 0) return;
  const list = offenders.map((o) => `  ${o.flag} — ${o.reason}`).join("\n");
  throw new ExecutionModeError(
    `The following flags are not supported in ${mode} execution mode:\n${list}`,
    hint,
  );
}
