// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run --report` wiring.
 *
 * Creates a run on the configured Appstrate instance via
 * `POST /api/runs/remote`, then returns an {@link HttpSink} the caller
 * composes with their `ConsoleSink` via `CompositeSink`. Every event the
 * bundle emits is streamed back to the platform in real time (HMAC-signed
 * Standard Webhooks) and becomes visible in the dashboard with a
 * "Remote runner" badge.
 *
 * Three modes:
 *   - `auto` — on when a profile + app are available, off otherwise
 *   - `true` — force on; fail if no profile / app / token
 *   - `false` — always off, console-only
 *
 * Failure handling is separated from the sink itself:
 *   - `abort`   (default) — any step of the initial registration fails →
 *                           exit the run. The user asked to report; we
 *                           don't silently degrade.
 *   - `console`           — registration failure falls back to console-only
 *                           with a warning. Useful for CI that runs even
 *                           when telemetry is down.
 */

import { HttpSink } from "@appstrate/afps-runtime/sinks";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import { parseScopedName } from "@appstrate/core/naming";

export type ReportMode = "auto" | "true" | "false";
export type ReportFallback = "abort" | "console";

export interface ReportOptions {
  mode: ReportMode;
  fallback: ReportFallback;
  /** Requested sink TTL in seconds. Clamped by the server. */
  ttlSeconds?: number;
}

export interface ReportContext {
  /**
   * Logged-in instance credentials. From `resolveAuthContext` +
   * remote-resolver inputs — reused verbatim so the caller's existing
   * auth story (API key or JWT) carries over without a second login
   * prompt.
   */
  instance: string;
  bearerToken: string;
  appId: string;
  orgId: string | null;
}

export interface ReportSession {
  runId: string;
  httpSink: HttpSink;
  /**
   * Headers to attach to every outbound LLM / credential proxy call —
   * populates `llm_usage.run_id` + `credential_proxy_usage.run_id`
   * so per-run cost rollup works at `/events/finalize` time.
   */
  proxyHeaders: Record<string, string>;
  /**
   * Base events URL (same one HttpSink POSTs to). Exposed so the
   * caller can derive the heartbeat endpoint and start a liveness
   * keep-alive — same mechanism the runtime-pi container uses.
   */
  sinkUrl: string;
  /**
   * Raw run secret. Required to sign heartbeat requests via the shared
   * `startSinkHeartbeat` helper. Also held inside `httpSink`, but not
   * exposed there on purpose — keeping the secret explicit at the
   * session boundary makes its use auditable.
   */
  runSecret: string;
}

/** User-provided execution-environment metadata attached to the run record. */
export interface ReportContextSnapshot {
  os: string;
  cliVersion: string;
  gitSha?: string;
  bundle: { name: string; version: string };
}

const CONTEXT_SNAPSHOT_MAX_BYTES = 16 * 1024;

/**
 * Decide whether reporting is on, based on the explicit mode and the
 * presence of credentials. `auto` turns off silently when there is no
 * context; `true` turns off loudly.
 */
export function shouldReport(mode: ReportMode, ctx: ReportContext | null): boolean {
  if (mode === "false") return false;
  if (mode === "true") {
    if (!ctx) {
      throw new ReportConfigError(
        "--report=true requires an Appstrate profile or API key",
        "Run `appstrate login`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_APP_ID",
      );
    }
    return true;
  }
  // auto
  return ctx !== null;
}

/**
 * Register a remote run against the instance and return a configured
 * HttpSink. The caller composes it with its local ConsoleSink. On
 * registration failure, the caller's fallback policy decides whether
 * to abort the run or continue console-only (see {@link ReportOptions}).
 */
export async function startReportSession(
  bundle: Bundle,
  ctx: ReportContext,
  opts: ReportOptions,
  contextSnapshot: ReportContextSnapshot,
): Promise<ReportSession> {
  const manifest = extractBundleManifest(bundle);
  const prompt = extractBundlePrompt(bundle);

  const body = {
    source: {
      kind: "inline" as const,
      manifest,
      prompt,
    },
    applicationId: ctx.appId,
    input: {},
    contextSnapshot: truncateSnapshot(contextSnapshot),
    ...(opts.ttlSeconds ? { sink: { ttlSeconds: opts.ttlSeconds } } : {}),
  };

  const url = `${ctx.instance.replace(/\/$/, "")}/api/runs/remote`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.bearerToken}`,
    // `/api/runs/*` is app-scoped; dashboard-user JWTs don't pin an app,
    // so the middleware requires `X-App-Id` explicitly. Missing this
    // rejects every remote run with `application_context_required`.
    "X-App-Id": ctx.appId,
  };
  if (ctx.orgId) headers["X-Org-Id"] = ctx.orgId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const snippet = await readSnippet(res);
    throw new ReportStartError(
      `POST /api/runs/remote failed with HTTP ${res.status}`,
      snippet ?? "(no response body)",
    );
  }

  const payload = (await res.json()) as {
    runId: string;
    url: string;
    finalizeUrl: string;
    secret: string;
    expiresAt: string;
  };

  const httpSink = new HttpSink({
    url: payload.url,
    finalizeUrl: payload.finalizeUrl,
    runSecret: payload.secret,
  });

  return {
    runId: payload.runId,
    httpSink,
    proxyHeaders: { "X-Run-Id": payload.runId },
    sinkUrl: payload.url,
    runSecret: payload.secret,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ReportConfigError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ReportConfigError";
  }
}

export class ReportStartError extends Error {
  constructor(
    message: string,
    public readonly responseSnippet: string,
  ) {
    super(`${message}\n    ${responseSnippet}`);
    this.name = "ReportStartError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractBundleManifest(bundle: Bundle): Record<string, unknown> {
  const root = bundle.packages.get(bundle.root);
  if (!root) {
    throw new ReportStartError(
      "Bundle has no root package",
      `bundle.root=${bundle.root} not found in bundle.packages`,
    );
  }
  const manifest = root.manifest as Record<string, unknown>;
  if (!manifest || typeof manifest !== "object") {
    throw new ReportStartError("Root package has no manifest", "");
  }
  return manifest;
}

function extractBundlePrompt(bundle: Bundle): string {
  const root = bundle.packages.get(bundle.root);
  const bytes = root?.files.get("prompt.md");
  if (!bytes) {
    throw new ReportStartError(
      "Root package has no prompt.md",
      "An agent bundle without a prompt cannot be executed remotely",
    );
  }
  return new TextDecoder().decode(bytes);
}

function truncateSnapshot(snap: ReportContextSnapshot): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    os: snap.os,
    cliVersion: snap.cliVersion,
    bundle: snap.bundle,
  };
  if (snap.gitSha) obj.gitSha = snap.gitSha;
  const serialized = JSON.stringify(obj);
  if (serialized.length > CONTEXT_SNAPSHOT_MAX_BYTES) {
    // Defensive trim — the server rejects oversized snapshots, this
    // catches it locally with a cleaner error message.
    throw new ReportStartError(
      `contextSnapshot exceeds ${CONTEXT_SNAPSHOT_MAX_BYTES} bytes`,
      "Reduce the snapshot payload or disable --report",
    );
  }
  return obj;
}

async function readSnippet(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.length > 512 ? `${text.slice(0, 512)}…` : text;
  } catch {
    return null;
  }
}

/**
 * Read the bundle's root package name + version. Unused today — exported
 * so the CLI surface can populate `ReportContextSnapshot.bundle` from a
 * single source.
 */
export function bundleIdentity(bundle: Bundle): { name: string; version: string } {
  const root = bundle.packages.get(bundle.root);
  const manifest = (root?.manifest ?? {}) as { name?: unknown; version?: unknown };
  const name = typeof manifest.name === "string" ? manifest.name : bundle.root;
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  // Sanity-normalize — if the name is already a scoped identifier we
  // pass through; otherwise parsing returns null and we fall back to raw.
  parseScopedName(name);
  return { name, version };
}
