// SPDX-License-Identifier: Apache-2.0

/**
 * TwoStep declarative connect engine (spec §4.8).
 *
 * Executes a manifest-declared chain of HTTP requests: substitute `{{...}}`
 * placeholders (from transient bootstrap `inputs` + inter-step `bind` state),
 * fire the request, extract values from the response, promote them to `bind`
 * (visible to later steps) and/or `outputs` (the final injectable bundle).
 *
 * This is a manifest-author-driven HTTP chainer → an SSRF / exfil / DoS
 * surface. It is bounded by construction:
 *   - every request URL must match the integration's `authorizedUris`
 *     allowlist (unless `allowAllUris`);
 *   - per-step timeout + total budget; capped redirects; capped response body;
 *   - regex patterns are length-capped (schema) and run against a size-capped
 *     body (true ReDoS needs RE2 — documented residual; the body cap bounds
 *     worst-case input length);
 *   - `{{...}}` resolves ONLY `inputs` + this flow's `bind` — never another
 *     connection's material; unresolved placeholders fail closed.
 *
 * Pure: no DB / Redis / sidecar. `fetchImpl` + `now` are injectable for tests.
 */

import {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
} from "../proxy-primitives.ts";
import { decodeJwtPayload } from "@appstrate/core/jwt";

export interface TwoStepLimits {
  stepTimeoutMs: number;
  totalBudgetMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

export const DEFAULT_TWOSTEP_LIMITS: TwoStepLimits = {
  stepTimeoutMs: 15_000,
  totalBudgetMs: 45_000,
  maxResponseBytes: 1_000_000,
  maxRedirects: 3,
};

export type TwoStepExtractor =
  | { from: "json"; path: string }
  | { from: "jwt"; token: string; path: string }
  | { from: "regex"; pattern: string; group?: number }
  | { from: "header"; name: string }
  | { from: "cookie"; name: string };

export interface TwoStepRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: "application/x-www-form-urlencoded" | "application/json";
}

export interface TwoStepStep {
  request: TwoStepRequest;
  okStatus?: number[];
  extract?: Record<string, TwoStepExtractor>;
  bind?: string[];
  output?: string[];
}

export interface TwoStepConfig {
  steps: TwoStepStep[];
  limits?: Partial<TwoStepLimits>;
  /** Output name holding seconds-to-expiry → computes expiresAt. */
  expiresInOutput?: string;
  /** Output names to also record as identity claims. */
  identityOutputs?: string[];
}

export interface TwoStepContext {
  /** Transient bootstrap secrets (e.g. password) for `{{...}}`. Never persisted by the engine. */
  inputs: Record<string, string>;
  /** Integration URL allowlist (global). Each step URL must match unless allowAllUris. */
  authorizedUris: string[] | null;
  allowAllUris: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TwoStepResult {
  outputs: Record<string, string>;
  identityClaims: Record<string, string>;
  expiresAt: string | null;
}

/** Structured failure — carries the step index + reason; never the response body. */
export class TwoStepError extends Error {
  constructor(
    message: string,
    readonly stepIndex: number,
    readonly reason:
      | "unresolved_placeholder"
      | "url_not_allowed"
      | "bad_status"
      | "response_too_large"
      | "timeout"
      | "extract_failed"
      | "budget_exceeded"
      | "invalid_config",
  ) {
    super(message);
    this.name = "TwoStepError";
  }
}

function isOkStatus(status: number, declared?: number[]): boolean {
  if (declared && declared.length > 0) return declared.includes(status);
  return status >= 200 && status < 300;
}

/** JSONPath-lite: `$.a.b`, with `[n]` array indices. Returns `undefined` on miss. */
function readJsonPath(root: unknown, path: string): unknown {
  const trimmed = path.startsWith("$.")
    ? path.slice(2)
    : path.startsWith("$")
      ? path.slice(1)
      : path;
  let cur: unknown = root;
  // Split into `.key` and `[index]` tokens.
  const tokens = trimmed.match(/[^.[\]]+/g) ?? [];
  for (const tok of tokens) {
    if (cur == null || typeof cur !== "object") return undefined;
    const asArray = cur as unknown[];
    const asObj = cur as Record<string, unknown>;
    cur = /^\d+$/.test(tok) ? asArray[Number(tok)] : asObj[tok];
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function parseSetCookie(headers: Headers, name: string): string | undefined {
  // Bun/undici expose getSetCookie(); fall back to the (folded) get().
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : undefined;
  const lines =
    raw && raw.length > 0 ? raw : (headers.get("set-cookie") ?? "").split(/,(?=[^ ;]+=)/);
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const cookieName = line.slice(0, eq).trim();
    if (cookieName === name) {
      const semi = line.indexOf(";", eq);
      return (semi === -1 ? line.slice(eq + 1) : line.slice(eq + 1, semi)).trim();
    }
  }
  return undefined;
}

async function readBoundedText(
  res: Response,
  maxBytes: number,
  stepIndex: number,
): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new TwoStepError(
      `step ${stepIndex}: response body ${buf.byteLength}B exceeds limit ${maxBytes}B`,
      stepIndex,
      "response_too_large",
    );
  }
  return new TextDecoder().decode(buf);
}

function applyExtractor(
  ex: TwoStepExtractor,
  bodyText: string,
  headers: Headers,
  scope: Record<string, string>,
  stepIndex: number,
  name: string,
): string {
  switch (ex.from) {
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new TwoStepError(
          `step ${stepIndex}: '${name}' json parse failed`,
          stepIndex,
          "extract_failed",
        );
      }
      return stringifyValue(readJsonPath(parsed, ex.path));
    }
    case "jwt": {
      // `token` names a value already in scope (a prior bind/output).
      const token = scope[ex.token];
      if (!token) {
        throw new TwoStepError(
          `step ${stepIndex}: '${name}' jwt token '${ex.token}' not in scope`,
          stepIndex,
          "extract_failed",
        );
      }
      const claims = decodeJwtPayload(token);
      if (!claims) {
        throw new TwoStepError(
          `step ${stepIndex}: '${name}' jwt decode failed`,
          stepIndex,
          "extract_failed",
        );
      }
      return stringifyValue(readJsonPath(claims, ex.path));
    }
    case "regex": {
      const re = new RegExp(ex.pattern);
      const m = re.exec(bodyText);
      if (!m) return "";
      return m[ex.group ?? 1] ?? "";
    }
    case "header":
      return headers.get(ex.name) ?? "";
    case "cookie":
      return parseSetCookie(headers, ex.name) ?? "";
  }
}

/**
 * Execute the declarative chain. Throws {@link TwoStepError} on the first
 * failure (no partial persistence — the caller persists nothing on throw).
 */
export async function runTwoStep(
  config: TwoStepConfig,
  ctx: TwoStepContext,
): Promise<TwoStepResult> {
  const limits: TwoStepLimits = { ...DEFAULT_TWOSTEP_LIMITS, ...config.limits };
  const doFetch = ctx.fetchImpl ?? fetch;
  const now = ctx.now ?? Date.now;
  const start = now();

  const bind: Record<string, string> = {};
  const outputs: Record<string, string> = {};

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i]!;
    if (now() - start > limits.totalBudgetMs) {
      throw new TwoStepError(
        `total connect budget ${limits.totalBudgetMs}ms exceeded`,
        i,
        "budget_exceeded",
      );
    }

    const vars = { ...ctx.inputs, ...bind };
    const url = substituteVars(step.request.url, vars);
    const body =
      step.request.body !== undefined ? substituteVars(step.request.body, vars) : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.request.headers ?? {}))
      headers[k] = substituteVars(v, vars);
    if (step.request.contentType && headers["Content-Type"] === undefined) {
      headers["Content-Type"] = step.request.contentType;
    }

    // Fail closed on any unresolved `{{...}}` (a typo'd placeholder must never
    // be sent literally upstream).
    const unresolved = [
      ...findUnresolvedPlaceholders(url),
      ...(body ? findUnresolvedPlaceholders(body) : []),
      ...Object.values(headers).flatMap(findUnresolvedPlaceholders),
    ];
    if (unresolved.length > 0) {
      throw new TwoStepError(
        `step ${i}: unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`,
        i,
        "unresolved_placeholder",
      );
    }

    // Per-step URL allowlist (defence beyond the SSRF blocklist).
    if (!ctx.allowAllUris) {
      const allowed = (ctx.authorizedUris ?? []).some((spec) =>
        matchesAuthorizedUriSpec(spec, url),
      );
      if (!allowed) {
        throw new TwoStepError(
          `step ${i}: url not in authorizedUris allowlist`,
          i,
          "url_not_allowed",
        );
      }
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), limits.stepTimeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: step.request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: ac.signal,
      });
    } catch (err) {
      if (ac.signal.aborted) {
        throw new TwoStepError(
          `step ${i}: timed out after ${limits.stepTimeoutMs}ms`,
          i,
          "timeout",
        );
      }
      throw new TwoStepError(`step ${i}: request failed: ${String(err)}`, i, "extract_failed");
    } finally {
      clearTimeout(timer);
    }

    if (!isOkStatus(res.status, step.okStatus)) {
      // Never log/echo the body — only the status.
      throw new TwoStepError(`step ${i}: unexpected status ${res.status}`, i, "bad_status");
    }

    const needsBody = Object.values(step.extract ?? {}).some(
      (e) => e.from === "json" || e.from === "regex",
    );
    const bodyText = needsBody ? await readBoundedText(res, limits.maxResponseBytes, i) : "";

    // Extract in two passes so a `jwt` extractor can reference any other
    // same-step value regardless of key order. We can't rely on insertion
    // order: the manifest is persisted as JSONB, which does NOT preserve key
    // order, so the decrypted `extract` map comes back reordered. Pass 1 runs
    // every self-contained extractor (json/regex/header/cookie); pass 2 runs
    // `jwt`, whose `token` names another extracted value (or a prior bind).
    const extracted: Record<string, string> = {};
    const entries = Object.entries(step.extract ?? {});
    for (const [name, ex] of entries) {
      if (ex.from === "jwt") continue;
      const scope = { ...bind, ...outputs, ...extracted };
      extracted[name] = applyExtractor(ex, bodyText, res.headers, scope, i, name);
    }
    for (const [name, ex] of entries) {
      if (ex.from !== "jwt") continue;
      const scope = { ...bind, ...outputs, ...extracted };
      extracted[name] = applyExtractor(ex, bodyText, res.headers, scope, i, name);
    }
    for (const name of step.bind ?? []) {
      if (!(name in extracted)) {
        throw new TwoStepError(
          `step ${i}: bind '${name}' has no matching extractor`,
          i,
          "invalid_config",
        );
      }
      bind[name] = extracted[name]!;
    }
    for (const name of step.output ?? []) {
      if (!(name in extracted)) {
        throw new TwoStepError(
          `step ${i}: output '${name}' has no matching extractor`,
          i,
          "invalid_config",
        );
      }
      outputs[name] = extracted[name]!;
    }
  }

  let expiresAt: string | null = null;
  if (config.expiresInOutput && outputs[config.expiresInOutput]) {
    const secs = Number(outputs[config.expiresInOutput]);
    if (Number.isFinite(secs) && secs > 0) {
      expiresAt = new Date(start + secs * 1000).toISOString();
    }
  }
  const identityClaims: Record<string, string> = {};
  for (const name of config.identityOutputs ?? []) {
    if (outputs[name] !== undefined) identityClaims[name] = outputs[name]!;
  }

  return { outputs, identityClaims, expiresAt };
}
