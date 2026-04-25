// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS `run_history` tool — zero-knowledge access to prior runs.
 *
 * The agent sees a typed `run_history({ limit?, fields? })` surface and
 * never learns how the data is fetched. Transport implementations live
 * behind a {@link RunHistoryCallFn} supplied by the runner:
 *
 *   - Container runs: {@link createSidecarRunHistoryCall} proxies to the
 *     platform sidecar, which in turn fetches `/internal/run-history`
 *     with the per-run Bearer token.
 *   - CLI / tests: hand-written call stubs for local or in-memory
 *     backends; no `LocalRunHistoryResolver` is shipped until a
 *     consumer materialises.
 *
 * Parity with {@link makeProviderTool}:
 *   - Same module layout (tool factory + transport factory in one file)
 *   - Same JSON-schema-strict, bounded parameter surface
 *   - Same `<domain>.called` run-event shape for observability
 *   - Same fail-fast semantics on transport faults (throw with context)
 */

import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.ts";

// ─────────────────────────────────────────────
// Wire shapes
// ─────────────────────────────────────────────

/** Wire-format field names accepted by `/internal/run-history`. */
export type RunHistoryField = "checkpoint" | "result";

export interface RunHistoryRequest {
  /** 1..50. Default 10 (applied by {@link makeRunHistoryTool}). */
  limit: number;
  /** Non-empty subset of `{"checkpoint","result"}`. Default `["checkpoint"]`. */
  fields: RunHistoryField[];
}

export interface RunHistoryEntry {
  id: string;
  status: string;
  /** ISO-8601 timestamp. */
  date: string;
  /** Run duration in milliseconds. */
  duration: number;
  /** Carry-over checkpoint from that run (present when requested). */
  checkpoint?: unknown;
  /** Final structured output from that run (present when requested). */
  result?: unknown;
}

export interface RunHistoryResponse {
  runs: RunHistoryEntry[];
}

/**
 * Transport callback. Implementations receive the request with defaults
 * already applied and bounds already enforced — they only need to
 * dispatch and parse the response.
 */
export type RunHistoryCallFn = (req: RunHistoryRequest) => Promise<RunHistoryResponse>;

// ─────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_FIELDS: readonly RunHistoryField[] = ["checkpoint"];
const VALID_FIELDS: readonly RunHistoryField[] = ["checkpoint", "result"];

/** Wire-level field vocabulary the platform's `/internal/run-history` endpoint accepts. */
const WIRE_FIELDS: readonly string[] = ["checkpoint", "result"];

export interface MakeRunHistoryToolOptions {
  /** Emit `run_history.called` events via `ctx.emit`. Default: true. */
  emitEvent?: boolean;
}

/**
 * Build the `run_history` tool. A single tool is surfaced per run (no
 * per-ref instantiation — unlike providers, there is exactly one history
 * backend per container).
 */
export function makeRunHistoryTool(
  call: RunHistoryCallFn,
  opts: MakeRunHistoryToolOptions = {},
): Tool {
  const emitEvent = opts.emitEvent ?? true;

  const parameters: JSONSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Number of past runs to return (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
      },
      fields: {
        type: "array",
        items: { type: "string", enum: [...VALID_FIELDS] },
        minItems: 1,
        maxItems: VALID_FIELDS.length,
        uniqueItems: true,
        description: `Data fields to include per run. Default: ["checkpoint"].`,
      },
    },
  };

  return {
    name: "run_history",
    description:
      "Fetch metadata and optionally the carry-over checkpoint or final output of the agent's most recent past runs (current run excluded). Use for trend analysis, auditing prior executions, or recovering from a failed run. Returns { runs: [{ id, status, date, duration, checkpoint?, result? }] } sorted most-recent first. Results are scoped to the current actor — checkpoints from other actors are never visible.",
    parameters,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const req = normalizeRequest(args);
      const started = Date.now();
      try {
        const response = await call(req);
        if (emitEvent) {
          emitCalled(ctx, {
            limit: req.limit,
            fields: req.fields,
            status: "success",
            durationMs: Date.now() - started,
            count: response.runs.length,
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (emitEvent) {
          emitCalled(ctx, {
            limit: req.limit,
            fields: req.fields,
            status: "error",
            durationMs: Date.now() - started,
            error: message,
          });
        }
        throw err;
      }
    },
  };
}

/**
 * Apply defaults and narrow the loose arg shape the LLM produces into a
 * deterministic {@link RunHistoryRequest}. Schema validation is the
 * LLM's responsibility (Pi enforces it) — this is a defensive projection
 * for the transport layer only.
 */
function normalizeRequest(args: unknown): RunHistoryRequest {
  const raw = (args ?? {}) as { limit?: unknown; fields?: unknown };
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit) && raw.limit >= 1
      ? Math.min(Math.floor(raw.limit), MAX_LIMIT)
      : DEFAULT_LIMIT;
  // Anything outside `WIRE_FIELDS` is dropped silently.
  const collected = new Set<RunHistoryField>();
  if (Array.isArray(raw.fields)) {
    for (const v of raw.fields) {
      if (typeof v !== "string" || !WIRE_FIELDS.includes(v)) continue;
      collected.add(v as RunHistoryField);
    }
  }
  return {
    limit,
    fields: collected.size > 0 ? [...collected] : [...DEFAULT_FIELDS],
  };
}

function emitCalled(
  ctx: ToolContext,
  payload: {
    limit: number;
    fields: RunHistoryField[];
    status: "success" | "error";
    durationMs: number;
    count?: number;
    error?: string;
  },
): void {
  ctx.emit({
    type: "run_history.called",
    timestamp: Date.now(),
    runId: ctx.runId,
    ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
    ...payload,
  });
}

// ─────────────────────────────────────────────
// Sidecar transport factory
// ─────────────────────────────────────────────

export interface CreateSidecarRunHistoryCallOptions {
  /** Base URL of the sidecar (e.g. `http://sidecar:8080`). */
  sidecarUrl: string;
  /** Override `fetch` (tests, custom agents). */
  fetch?: typeof fetch;
  /** Extra headers forwarded on every dispatch. */
  baseHeaders?: Record<string, string>;
  /** Abort the dispatch after N ms. Default: 10_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a {@link RunHistoryCallFn} that dispatches to the Appstrate
 * sidecar's `GET /run-history` endpoint. The sidecar owns authentication
 * (per-run Bearer token) and forwards to the platform's
 * `/internal/run-history` — the runtime never sees either.
 */
export function createSidecarRunHistoryCall(
  opts: CreateSidecarRunHistoryCallOptions,
): RunHistoryCallFn {
  if (!opts.sidecarUrl) {
    throw new Error("createSidecarRunHistoryCall: sidecarUrl is required");
  }
  const sidecarUrl = opts.sidecarUrl.replace(/\/$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const baseHeaders = opts.baseHeaders ?? {};
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (req) => {
    const params = new URLSearchParams();
    params.set("limit", String(req.limit));
    params.set("fields", req.fields.join(","));
    const url = `${sidecarUrl}/run-history?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { ...baseHeaders },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `run_history: sidecar call timed out after ${timeoutMs}ms (${sidecarUrl}/run-history)`,
        );
      }
      throw new Error(
        `run_history: sidecar call failed (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `run_history: sidecar returned HTTP ${res.status} — ${truncateForError(text)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `run_history: sidecar returned non-JSON body (status ${res.status}): ${truncateForError(text)}`,
      );
    }

    if (!isRunHistoryResponse(parsed)) {
      throw new Error(`run_history: sidecar response missing "runs" array (status ${res.status})`);
    }
    return parsed;
  };
}

function isRunHistoryResponse(v: unknown): v is RunHistoryResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { runs?: unknown }).runs) &&
    (v as { runs: unknown[] }).runs.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { status?: unknown }).status === "string" &&
        typeof (entry as { date?: unknown }).date === "string" &&
        typeof (entry as { duration?: unknown }).duration === "number",
    )
  );
}

function truncateForError(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated, ${text.length - max} more bytes)`;
}
