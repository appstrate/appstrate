// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative login engine (AFPS 2.0 §7.7, spec §4.8).
 *
 * Executes a manifest-declared single login request: substitute `{{...}}`
 * placeholders (from the transient bootstrap `inputs`) into one HTTP request,
 * fire it, and extract the injectable token/cookie values declared in
 * `connect.login.outputs` into `outputs` (the final injectable bundle).
 * Intentionally stateless: no request chaining, no cookie jar, no redirect
 * following. Stateful flows (multi-cookie sessions, TLS impersonation, refresh,
 * redirect chains) belong on the Orchestrated `connect.tool` path, not here.
 *
 * The `connect` block is consumed in AFPS 2.0 shape (snake_case). Each
 * `outputs[name]` is either an Arazzo
 * runtime-expression string (`$response.body#/<json-pointer>`,
 * `$response.header.<name>`, `$statusCode`) or an AFPS extractor object
 * (`{ from: "cookie"|"jwt"|"regex", ... }`).
 *
 * This is a manifest-author-driven HTTP request → an SSRF / exfil / DoS
 * surface. It is bounded by construction:
 *   - the request URL must match the integration's `authorizedUris` allowlist
 *     (the author's explicit trust boundary); when `allowAllUris` waives the
 *     allowlist, the SSRF blocklist (loopback/RFC1918/link-local/metadata)
 *     applies instead so there is never an unbounded in-process fetch;
 *   - per-request timeout; capped response body;
 *   - regex patterns are length-capped (schema) and run against a size-capped
 *     body (true ReDoS needs RE2 — documented residual; the body cap bounds
 *     worst-case input length);
 *   - `{{...}}` resolves ONLY `inputs` — never another connection's material;
 *     unresolved placeholders fail closed.
 *   - a declared `output` whose extractor produced an empty/undefined value
 *     fails closed too — never persist a silently-empty required value.
 *
 * Pure: no DB / Redis / sidecar. `fetchImpl` + `now` are injectable for tests.
 */

import {
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
} from "../proxy-primitives.ts";
import { decodeJwtPayload } from "@appstrate/core/jwt";
import { isBlockedUrl } from "@appstrate/core/ssrf";

export interface LoginLimits {
  // Per-request timeout. Maps to the manifest field `connect.limits.request_timeout_ms`.
  stepTimeoutMs: number;
  maxResponseBytes: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  stepTimeoutMs: 15_000,
  maxResponseBytes: 1_000_000,
};

/**
 * An AFPS 2.0 `connect.login.outputs` entry. Either an Arazzo runtime
 * expression string, or an extractor object.
 */
export type LoginOutput =
  | string
  | { from: "cookie"; name: string }
  | { from: "jwt"; token: string; path: string }
  | { from: "regex"; source?: string; pattern: string; group?: number };

export interface LoginRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  content_type?: string;
}

export interface ArazzoCriterion {
  condition: string;
}

export interface LoginRequestSpec {
  request: LoginRequest;
  success_criteria?: ArazzoCriterion[];
  outputs?: Record<string, LoginOutput>;
  expires_in_output?: string;
  identity_outputs?: string[];
}

export interface LoginConfig {
  login: LoginRequestSpec;
  limits?: {
    request_timeout_ms?: number;
    max_response_bytes?: number;
  };
}

export interface LoginContext {
  /** Transient bootstrap secrets (e.g. password) for `{{...}}`. Never persisted by the engine. */
  inputs: Record<string, string>;
  /** Integration URL allowlist (global). The request URL must match unless allowAllUris. */
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

/** Structured failure — carries the reason; never the response body. */
export class LoginError extends Error {
  constructor(
    message: string,
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

/**
 * Evaluate AFPS `success_criteria` (Arazzo). We only support the equality form
 * the decoder emits (`$statusCode == <n>`). When no criteria are declared,
 * default to the 2xx range. Any unrecognised criterion is treated
 * conservatively as a failure to pass.
 */
function passesSuccessCriteria(status: number, criteria?: ArazzoCriterion[]): boolean {
  if (!criteria || criteria.length === 0) return status >= 200 && status < 300;
  return criteria.every((c) => {
    const m = /^\s*\$statusCode\s*==\s*(\d+)\s*$/.exec(c.condition);
    if (!m) return false;
    return status === Number(m[1]);
  });
}

/**
 * RFC 6901 JSON-pointer read. `/a/b/0` → root.a.b[0]. Empty pointer ("") →
 * the document itself. Returns `undefined` on a miss. Decodes `~1` → `/` and
 * `~0` → `~` per RFC 6901.
 */
function readJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
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

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    throw new LoginError(
      `response body ${buf.byteLength}B exceeds limit ${maxBytes}B`,
      "response_too_large",
    );
  }
  return new TextDecoder().decode(buf);
}

/** A `{$credential.<field>}` template referencing exactly one output field. */
const SINGLE_CREDENTIAL_REF = /^\{\$credential\.([A-Za-z0-9_]+)\}$/;

/**
 * Resolve a jwt extractor's `token` reference. AFPS 2.0 expresses it as a
 * `{$credential.<field>}` template (a reference to another extracted output);
 * a bare field name is also accepted for resilience.
 */
function resolveTokenRef(token: string, scope: Record<string, string>): string | undefined {
  const m = SINGLE_CREDENTIAL_REF.exec(token);
  const field = m ? m[1]! : token;
  return scope[field];
}

/** Whether an output expression must consume the response body to resolve. */
function outputNeedsBody(out: LoginOutput): boolean {
  if (typeof out === "string") return out.startsWith("$response.body");
  return out.from === "regex"; // jwt resolves from another (already-extracted) value
}

/**
 * Apply one AFPS 2.0 `outputs` expression. `scope` carries values already
 * extracted in this pass (for jwt `token` resolution). Returns `undefined`
 * when the expression is unrecognised or its target is absent — the caller
 * fails closed on `undefined`/empty for declared outputs.
 */
function applyOutput(
  out: LoginOutput,
  bodyText: string,
  status: number,
  headers: Headers,
  scope: Record<string, string>,
  name: string,
): string | undefined {
  if (typeof out === "string") {
    // Arazzo runtime expressions.
    if (out === "$statusCode") return String(status);
    if (out.startsWith("$response.body#")) {
      const pointer = out.slice("$response.body#".length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new LoginError(`'${name}' json parse failed`, "extract_failed");
      }
      const v = readJsonPointer(parsed, pointer);
      return v === undefined ? undefined : stringifyValue(v);
    }
    if (out.startsWith("$response.header.")) {
      const headerName = out.slice("$response.header.".length);
      return headers.get(headerName) ?? undefined;
    }
    // Unrecognised runtime expression → fail closed.
    throw new LoginError(`'${name}' unsupported output expression`, "invalid_config");
  }

  switch (out.from) {
    case "cookie":
      return parseSetCookie(headers, out.name);
    case "jwt": {
      const token = resolveTokenRef(out.token, scope);
      if (!token) {
        throw new LoginError(`'${name}' jwt token '${out.token}' not in scope`, "extract_failed");
      }
      const claims = decodeJwtPayload(token);
      if (!claims) {
        throw new LoginError(`'${name}' jwt decode failed`, "extract_failed");
      }
      const v = readJsonPointer(claims, out.path);
      return v === undefined ? undefined : stringifyValue(v);
    }
    case "regex": {
      const re = new RegExp(out.pattern);
      const m = re.exec(bodyText);
      if (!m) return undefined;
      return m[out.group ?? 1] ?? undefined;
    }
    default:
      throw new LoginError(`'${name}' unsupported extractor`, "invalid_config");
  }
}

/**
 * Execute the declarative login request. Throws {@link LoginError} on the
 * first failure (no partial persistence — the caller persists nothing on throw).
 */
export async function runLogin(config: LoginConfig, ctx: LoginContext): Promise<LoginResult> {
  const limits: LoginLimits = {
    stepTimeoutMs: config.limits?.request_timeout_ms ?? DEFAULT_LOGIN_LIMITS.stepTimeoutMs,
    maxResponseBytes: config.limits?.max_response_bytes ?? DEFAULT_LOGIN_LIMITS.maxResponseBytes,
  };
  const doFetch = ctx.fetchImpl ?? fetch;
  const now = ctx.now ?? Date.now;
  const start = now();

  const outputs: Record<string, string> = {};

  // `connect.login` is a single, stateless login request (spec §4.8).
  const login = config.login;
  if (!login) {
    throw new LoginError("connect.login declared no login request", "invalid_config");
  }

  const vars = { ...ctx.inputs };
  const url = substituteVars(login.request.url, vars);
  const body =
    login.request.body !== undefined ? substituteVars(login.request.body, vars) : undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(login.request.headers ?? {}))
    headers[k] = substituteVars(v, vars);
  if (login.request.content_type && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = login.request.content_type;
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
      `unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`,
      "unresolved_placeholder",
    );
  }

  // URL gate. This engine runs in the platform process (not the
  // credential-isolating sidecar), so the request URL is a manifest-authored
  // SSRF surface. Two mutually-exclusive controls:
  //   - allowlist present (`!allowAllUris`): the `authorizedUris` patterns are
  //     the author's explicit, auditable trust boundary — honor them verbatim
  //     (a self-hosted integration may legitimately scope to a LAN host).
  //   - `allowAllUris` (no allowlist): there is no author-declared boundary, so
  //     fall back to the SSRF blocklist to refuse loopback/RFC1918/link-local/
  //     cloud-metadata targets the platform could otherwise be steered to.
  if (ctx.allowAllUris) {
    if (isBlockedUrl(url)) {
      throw new LoginError("url targets a blocked/internal address", "url_not_allowed");
    }
  } else {
    const allowed = (ctx.authorizedUris ?? []).some((spec) => matchesAuthorizedUriSpec(spec, url));
    if (!allowed) {
      throw new LoginError("url not in authorizedUris allowlist", "url_not_allowed");
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limits.stepTimeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: login.request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) {
      throw new LoginError(`timed out after ${limits.stepTimeoutMs}ms`, "timeout");
    }
    throw new LoginError(`request failed: ${String(err)}`, "extract_failed");
  } finally {
    clearTimeout(timer);
  }

  if (!passesSuccessCriteria(res.status, login.success_criteria)) {
    // Never log/echo the body — only the status.
    throw new LoginError(`unexpected status ${res.status}`, "bad_status");
  }

  const outputEntries = Object.entries(login.outputs ?? {});
  const needsBody = outputEntries.some(([, out]) => outputNeedsBody(out));
  const bodyText = needsBody ? await readBoundedText(res, limits.maxResponseBytes) : "";

  // Extract in two passes so a `jwt` extractor can reference any other
  // same-request value regardless of key order. We can't rely on insertion
  // order: the manifest is persisted as JSONB, which does NOT preserve key
  // order, so the decrypted `outputs` map comes back reordered. Pass 1 runs
  // every self-contained expression (body/header/cookie/regex/statusCode);
  // pass 2 runs `jwt`, whose `token` names another extracted value.
  const extracted: Record<string, string> = {};
  const isJwt = (out: LoginOutput): boolean => typeof out !== "string" && out.from === "jwt";
  for (const [name, out] of outputEntries) {
    if (isJwt(out)) continue;
    const v = applyOutput(out, bodyText, res.status, res.headers, extracted, name);
    if (v !== undefined) extracted[name] = v;
  }
  for (const [name, out] of outputEntries) {
    if (!isJwt(out)) continue;
    const scope = { ...extracted };
    const v = applyOutput(out, bodyText, res.status, res.headers, scope, name);
    if (v !== undefined) extracted[name] = v;
  }

  // Every declared output is a required injectable. An absent or empty value
  // fails closed: persisting "" would yield a silently-broken connection
  // (e.g. `Authorization: Bearer ` or `Cookie: JSESSIONID=`).
  for (const [name] of outputEntries) {
    const value = extracted[name];
    if (value === undefined || value === "") {
      throw new LoginError(`output '${name}' extracted an empty value`, "extract_failed");
    }
    outputs[name] = value;
  }

  let expiresAt: string | null = null;
  if (login.expires_in_output && outputs[login.expires_in_output]) {
    const secs = Number(outputs[login.expires_in_output]);
    if (Number.isFinite(secs) && secs > 0) {
      expiresAt = new Date(start + secs * 1000).toISOString();
    }
  }
  const identityClaims: Record<string, string> = {};
  for (const name of login.identity_outputs ?? []) {
    if (outputs[name] !== undefined) identityClaims[name] = outputs[name]!;
  }

  return { outputs, identityClaims, expiresAt };
}
