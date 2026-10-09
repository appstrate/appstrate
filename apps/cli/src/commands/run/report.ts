// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate run --report` wiring.
 *
 * Creates a run on the configured Appstrate instance via
 * `POST /api/runs/remote`, then returns an {@link HttpSink} the caller
 * composes with their console sink (`createConsoleSink`, `./sink.ts`) via
 * `CompositeSink`. Every event the
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
import { UNAVAILABLE_INTEGRATION_REASONS, type Bundle } from "@appstrate/afps-runtime/bundle";
import type { ConnectionResolutionWarningCode } from "@appstrate/core/integration";
import { parseScopedName } from "@appstrate/core/naming";
import {
  connectionRefusalLines,
  parseLaunchWarnings,
  type LaunchWarning,
} from "./launch-warnings.ts";

export type ReportMode = "auto" | "true" | "false";
export type ReportFallback = "abort" | "console";

interface ReportOptions {
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
  spaceId: string;
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
  /** The registration's `warnings`: integrations the run starts without. */
  warnings: LaunchWarning[];
}

/** User-provided execution-environment metadata attached to the run record. */
interface ReportContextSnapshot {
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
        "Run `appstrate login`, or set APPSTRATE_API_KEY + APPSTRATE_INSTANCE + APPSTRATE_SPACE_ID",
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
 * HttpSink. The caller composes it with its local console sink. On
 * registration failure, the caller's fallback policy decides whether
 * to abort the run or continue console-only (see {@link ReportOptions}).
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
    // `/api/runs/*` is space-scoped; dashboard-user JWTs don't pin a space,
    // so the middleware requires `X-Space-Id` explicitly. Missing this
    // rejects every remote run with "Space context required".
    "X-Space-Id": ctx.spaceId,
  };
  if (ctx.orgId) headers["X-Org-Id"] = ctx.orgId;

  const sink = opts.ttlSeconds ? { sink: { ttl_seconds: opts.ttlSeconds } } : {};
  const baseBody = {
    spaceId: ctx.spaceId,
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

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => null);
    throw new ReportStartError(
      `POST /api/runs/remote failed with HTTP ${res.status}`,
      refusalSummary(text) ?? snippet(text) ?? "(no response body)",
    );
  }

  // Operation envelope: one-time sink credentials + the created run's `id`.
  const payload = (await res.json()) as {
    id: string;
    url: string;
    finalize_url: string;
    secret: string;
    expiresAt: string;
    warnings?: unknown;
  };

  const httpSink = new HttpSink({
    url: payload.url,
    finalizeUrl: payload.finalize_url,
    runSecret: payload.secret,
  });

  return {
    runId: payload.id,
    httpSink,
    proxyHeaders: { "X-Run-Id": payload.id },
    sinkUrl: payload.url,
    runSecret: payload.secret,
    warnings: parseLaunchWarnings(payload.warnings),
  };
}

/**
 * The agent-facing reason per warning code, worded as the platform's own prompt words it: the run
 * binds `[]` whatever the cause, so every code but a switched-off integration reads "unbound".
 */
const UNAVAILABLE_REASON: Record<ConnectionResolutionWarningCode, string> = {
  not_connected: UNAVAILABLE_INTEGRATION_REASONS.unbound,
  must_choose_connection: UNAVAILABLE_INTEGRATION_REASONS.unbound,
  auth_key_mismatch: UNAVAILABLE_INTEGRATION_REASONS.unbound,
  integration_unbound: UNAVAILABLE_INTEGRATION_REASONS.unbound,
  integration_not_active: UNAVAILABLE_INTEGRATION_REASONS.not_active,
};

/** Integrations the run is bound to none of, one per id, for "Unavailable Integrations". */
export function unavailableIntegrations(
  warnings: readonly LaunchWarning[],
): Array<{ id: string; reason: string }> {
  const byId = new Map<string, string>();
  for (const { field, code } of warnings) {
    if (!field.startsWith("integrations.")) continue;
    const id = field.slice("integrations.".length);
    if (!byId.has(id)) byId.set(id, UNAVAILABLE_REASON[code]);
  }
  return [...byId].map(([id, reason]) => ({ id, reason }));
}

/** The bundle minus the root's `ids` integrations, whose proxy calls would be refused. */
export function withoutIntegrations(bundle: Bundle, ids: readonly string[]): Bundle {
  const root = bundle.packages.get(bundle.root);
  const manifest = root?.manifest as
    { dependencies?: { integrations?: Record<string, unknown> } } | undefined;
  const declared = manifest?.dependencies?.integrations;
  if (!root || !manifest || !declared || !ids.some((id) => id in declared)) return bundle;
  const integrations = Object.fromEntries(
    Object.entries(declared).filter(([id]) => !ids.includes(id)),
  );
  const packages = new Map(bundle.packages);
  packages.set(bundle.root, {
    ...root,
    manifest: { ...manifest, dependencies: { ...manifest.dependencies, integrations } },
  } as typeof root);
  return { ...bundle, packages };
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

/** A 409 `missing_integration_connection`, one item per line at the snippet's indent. */
function refusalSummary(text: string | null): string | null {
  if (text === null) return null;
  try {
    return connectionRefusalLines(JSON.parse(text))?.join("\n    ") ?? null;
  } catch {
    return null;
  }
}

function snippet(text: string | null): string | null {
  if (text === null) return null;
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
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
