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
  applicationId: string;
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
 * Discriminator for how to register a remote run:
 *   - `inline`   — ship the manifest+prompt verbatim (true ad-hoc agent,
 *                  or a runner whose package isn't in the catalog).
 *   - `registry` — declare the package by id and let the server load
 *                  its own copy. Deterministic attribution, no shadow
 *                  row, no "Inline" badge in the UI.
 */
export type ReportSource =
  | { kind: "inline"; bundle: Bundle }
  | {
      kind: "registry";
      bundle: Bundle;
      packageId: string;
      /** Lifecycle stage of the package the runner downloaded — wire field is `stage`. */
      stage: "draft" | "published";
      spec?: string | undefined;
      integrity?: string | undefined;
    };

/**
 * Register a remote run against the instance and return a configured
 * HttpSink. The caller composes it with its local ConsoleSink. On
 * registration failure, the caller's fallback policy decides whether
 * to abort the run or continue console-only (see {@link ReportOptions}).
 *
 * For `kind: "registry"`, the server returning a 400 with code
 * `invalid_request` (or any 4xx surfaced as a Zod validation error)
 * triggers an automatic fallback to the inline path with a stderr
 * warning. This covers the new-CLI / old-server combination — the
 * runner already has the bundle in memory, so re-posting it as inline
 * keeps the run moving instead of dying on a wire-format mismatch.
 */
export async function startReportSession(
  reportSource: ReportSource,
  ctx: ReportContext,
  opts: ReportOptions,
  contextSnapshot: ReportContextSnapshot,
): Promise<ReportSession> {
  const url = `${ctx.instance.replace(/\/$/, "")}/api/runs/remote`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.bearerToken}`,
    // `/api/runs/*` is app-scoped; dashboard-user JWTs don't pin an app,
    // so the middleware requires `X-Application-Id` explicitly. Missing this
    // rejects every remote run with `application_context_required`.
    "X-Application-Id": ctx.applicationId,
  };
  if (ctx.orgId) headers["X-Org-Id"] = ctx.orgId;

  const sink = opts.ttlSeconds ? { sink: { ttlSeconds: opts.ttlSeconds } } : {};
  const baseBody = {
    applicationId: ctx.applicationId,
    input: {},
    contextSnapshot: truncateSnapshot(contextSnapshot),
    ...sink,
  };

  let body: Record<string, unknown>;
  if (reportSource.kind === "registry") {
    body = {
      ...baseBody,
      source: {
        kind: "registry" as const,
        packageId: reportSource.packageId,
        stage: reportSource.stage,
        ...(reportSource.spec ? { spec: reportSource.spec } : {}),
        ...(reportSource.integrity ? { integrity: reportSource.integrity } : {}),
      },
    };
  } else {
    body = {
      ...baseBody,
      source: {
        kind: "inline" as const,
        manifest: extractBundleManifest(reportSource.bundle),
        prompt: extractBundlePrompt(reportSource.bundle),
      },
    };
  }

  let res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  // New-CLI / old-server: the registry branch lands as a 400 on the Zod
  // discriminated-union check. Fall back to inline once, with a stderr
  // breadcrumb so the upgrade incentive is visible. Skip the retry for
  // any other 4xx (auth, rate limit, real validation error) — those
  // would loop or mask the real failure.
  if (!res.ok && res.status === 400 && reportSource.kind === "registry") {
    const peek = await peekProblemBody(res);
    if (looksLikeUnknownRegistryKind(peek)) {
      process.stderr.write(
        "warn: server doesn't support kind: 'registry' source — falling back to inline (run will show as Inline in the dashboard)\n",
      );
      const inlineBody = {
        ...baseBody,
        source: {
          kind: "inline" as const,
          manifest: extractBundleManifest(reportSource.bundle),
          prompt: extractBundlePrompt(reportSource.bundle),
        },
      };
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(inlineBody),
      });
    }
  }

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

interface PeekedProblem {
  raw: string;
  code: string | null;
  detail: string | null;
}

/**
 * Peek a response body once for fallback heuristics, leaving the
 * original Response cloned so a downstream {@link readSnippet} can
 * still read the body when we surface the error. Parses RFC 9457
 * problem+json fields when present so the heuristic doesn't have to
 * guess at the shape.
 */
async function peekProblemBody(res: Response): Promise<PeekedProblem> {
  try {
    const text = await res.clone().text();
    const raw = text.length > 512 ? `${text.slice(0, 512)}…` : text;
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj["code"] === "string") code = obj["code"] as string;
        if (typeof obj["detail"] === "string") detail = obj["detail"] as string;
      }
    } catch {
      // Non-JSON body — code/detail stay null, raw still serves the heuristic.
    }
    return { raw, code, detail };
  } catch {
    return { raw: "", code: null, detail: null };
  }
}

/**
 * Heuristic: does this 400 look like the server rejected the
 * `kind: "registry"` discriminator (i.e. an old build before the
 * registry source landed)? Two signals, both required:
 *   1. RFC 9457 `code` is `invalid_request` (Hono's `parseBody`
 *      validation surface — anything else like rate-limit, auth, app
 *      context errors carry distinct codes).
 *   2. The detail/raw mentions the source field path or the registry
 *      kind explicitly.
 *
 * Without (1) we'd false-positive on rate-limit JSON bodies that
 * happen to mention `source`. Without (2) we'd false-positive on any
 * unrelated invalid_request (e.g. a malformed `applicationId`).
 */
function looksLikeUnknownRegistryKind(peek: PeekedProblem): boolean {
  if (!peek.raw) return false;
  if (peek.code !== "invalid_request") return false;
  // Use the structured `detail` when present, otherwise fall back to the
  // raw body. The substring set is intentionally narrow — we only match
  // path/value tokens that a Zod error from the `source` discriminator
  // would emit ("source.kind", "Invalid discriminator value").
  const haystack = (peek.detail ?? peek.raw).toLowerCase();
  return (
    haystack.includes("source.kind") ||
    haystack.includes("'source'") ||
    haystack.includes('"source"') ||
    haystack.includes("discriminator") ||
    haystack.includes("registry")
  );
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
