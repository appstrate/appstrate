// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative login engine (spec §4.8).
 *
 * Executes a manifest-declared single login request: substitute `{{...}}`
 * placeholders (from the transient bootstrap `inputs`) into one HTTP request,
 * fire it, and extract the injectable token/cookie values from its response
 * into `outputs` (the final injectable bundle). Intentionally stateless: no
 * inter-step state, no cookie jar, no redirect following. Stateful flows
 * (multi-cookie sessions, TLS impersonation, refresh, redirect chains) belong
 * on the Orchestrated `connect.tool` path, not here.
 *
 * This is a manifest-author-driven HTTP request → an SSRF / exfil / DoS
 * surface. It is bounded by construction:
 *   - the request URL must match the integration's `authorizedUris` allowlist
 *     (unless `allowAllUris`);
 *   - per-request timeout; capped response body;
 *   - regex patterns are length-capped (schema) and run against a size-capped
 *     body (true ReDoS needs RE2 — documented residual; the body cap bounds
 *     worst-case input length);
 *   - `{{...}}` resolves ONLY `inputs` — never another connection's material;
 *     unresolved placeholders fail closed.
 *   - a declared `output` whose extractor produced an empty string fails closed
 *     too — never persist a silently-empty required value.
 *
 * Pure: no DB / Redis / sidecar. `fetchImpl` + `now` are injectable for tests.
 */

import {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
} from "../proxy-primitives.ts";
import { decodeJwtPayload } from "@appstrate/core/jwt";

export interface LoginLimits {
  stepTimeoutMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  stepTimeoutMs: 15_000,
  maxResponseBytes: 1_000_000,
};

export type LoginExtractor =
  | { from: "json"; path: string }
  | { from: "jwt"; token: string; path: string }
  | { from: "regex"; pattern: string; group?: number }
  | { from: "header"; name: string }
  | { from: "cookie"; name: string };

export interface LoginRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: "application/x-www-form-urlencoded" | "application/json";
}

export interface LoginStep {
  request: LoginRequest;
  okStatus?: number[];
  extract?: Record<string, LoginExtractor>;
  output?: string[];
}

export interface LoginConfig {
  steps: LoginStep[];
  limits?: Partial<LoginLimits>;
  /** Output name holding seconds-to-expiry → computes expiresAt. */
  expiresInOutput?: string;
  /** Output names to also record as identity claims. */
  identityOutputs?: string[];
}

export interface LoginContext {
  /** Transient bootstrap secrets (e.g. password) for `{{...}}`. Never persisted by the engine. */
  inputs: Record<string, string>;
  /** Integration URL allowlist (global). Each step URL must match unless allowAllUris. */
  authorizedUris: string[] | null;
  allowAllUris: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface LoginResult {
  outputs: Record<string, string>;
  identityClaims: Record<string, string>;
  expiresAt: string | null;
}

/** Structured failure — carries the step index + reason; never the response body. */
export class LoginError extends Error {
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
      | "invalid_config",
  ) {
    super(message);
    this.name = "LoginError";
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
    throw new LoginError(
      `step ${stepIndex}: response body ${buf.byteLength}B exceeds limit ${maxBytes}B`,
      stepIndex,
      "response_too_large",
    );
  }
  return new TextDecoder().decode(buf);
}

function applyExtractor(
  ex: LoginExtractor,
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
        throw new LoginError(
          `step ${stepIndex}: '${name}' json parse failed`,
          stepIndex,
          "extract_failed",
        );
      }
      return stringifyValue(readJsonPath(parsed, ex.path));
    }
    case "jwt": {
      // `token` names another value extracted from the same response.
      const token = scope[ex.token];
      if (!token) {
        throw new LoginError(
          `step ${stepIndex}: '${name}' jwt token '${ex.token}' not in scope`,
          stepIndex,
          "extract_failed",
        );
      }
      const claims = decodeJwtPayload(token);
      if (!claims) {
        throw new LoginError(
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
 * Execute the declarative login request. Throws {@link LoginError} on the
 * first failure (no partial persistence — the caller persists nothing on throw).
 */
export async function runLogin(config: LoginConfig, ctx: LoginContext): Promise<LoginResult> {
  const limits: LoginLimits = { ...DEFAULT_LOGIN_LIMITS, ...config.limits };
  const doFetch = ctx.fetchImpl ?? fetch;
  const now = ctx.now ?? Date.now;
  const start = now();

  const outputs: Record<string, string> = {};

  // The schema caps `connect.steps` at exactly one (spec §4.8): a single,
  // stateless login request. Process it (index 0 throughout).
  const step = config.steps[0];
  if (!step) {
    throw new LoginError("connect.steps declared no login request", 0, "invalid_config");
  }

  const vars = { ...ctx.inputs };
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
    throw new LoginError(
      `step 0: unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`,
      0,
      "unresolved_placeholder",
    );
  }

  // URL allowlist (defence beyond the SSRF blocklist).
  if (!ctx.allowAllUris) {
    const allowed = (ctx.authorizedUris ?? []).some((spec) => matchesAuthorizedUriSpec(spec, url));
    if (!allowed) {
      throw new LoginError("step 0: url not in authorizedUris allowlist", 0, "url_not_allowed");
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
      throw new LoginError(`step 0: timed out after ${limits.stepTimeoutMs}ms`, 0, "timeout");
    }
    throw new LoginError(`step 0: request failed: ${String(err)}`, 0, "extract_failed");
  } finally {
    clearTimeout(timer);
  }

  if (!isOkStatus(res.status, step.okStatus)) {
    // Never log/echo the body — only the status.
    throw new LoginError(`step 0: unexpected status ${res.status}`, 0, "bad_status");
  }

  const needsBody = Object.values(step.extract ?? {}).some(
    (e) => e.from === "json" || e.from === "regex",
  );
  const bodyText = needsBody ? await readBoundedText(res, limits.maxResponseBytes, 0) : "";

  // Extract in two passes so a `jwt` extractor can reference any other
  // same-request value regardless of key order. We can't rely on insertion
  // order: the manifest is persisted as JSONB, which does NOT preserve key
  // order, so the decrypted `extract` map comes back reordered. Pass 1 runs
  // every self-contained extractor (json/regex/header/cookie); pass 2 runs
  // `jwt`, whose `token` names another extracted value.
  const extracted: Record<string, string> = {};
  const entries = Object.entries(step.extract ?? {});
  for (const [name, ex] of entries) {
    if (ex.from === "jwt") continue;
    const scope = { ...extracted };
    extracted[name] = applyExtractor(ex, bodyText, res.headers, scope, 0, name);
  }
  for (const [name, ex] of entries) {
    if (ex.from !== "jwt") continue;
    const scope = { ...extracted };
    extracted[name] = applyExtractor(ex, bodyText, res.headers, scope, 0, name);
  }
  for (const name of step.output ?? []) {
    if (!(name in extracted)) {
      throw new LoginError(
        `step 0: output '${name}' has no matching extractor`,
        0,
        "invalid_config",
      );
    }
    // Fail closed on a present-but-empty extraction: a declared `output` is a
    // required injectable. Persisting "" would yield a silently-broken
    // connection (e.g. `Authorization: Bearer ` or `Cookie: JSESSIONID=`).
    if (extracted[name] === "") {
      throw new LoginError(
        `step 0: output '${name}' extracted an empty value`,
        0,
        "extract_failed",
      );
    }
    outputs[name] = extracted[name]!;
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
