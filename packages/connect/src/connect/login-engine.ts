// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative login engine (AFPS §7.7, spec §4.8).
 *
 * Executes a manifest-declared single login request: substitute `{{...}}`
 * placeholders (from the transient bootstrap `inputs`) into one HTTP request,
 * fire it, and extract the injectable token/cookie values declared in
 * `connect.login.outputs` into `outputs` (the final injectable bundle).
 * Intentionally stateless: no request chaining, no cookie jar, no redirect
 * following. Stateful flows (multi-cookie sessions, TLS impersonation, refresh,
 * redirect chains) belong on the Orchestrated `connect.tool` path, not here.
 *
 * The `connect` block (AFPS, snake_case) is checked up front by `loginBlockIssues`
 * (`@appstrate/afps-shared/runtime-expression`), as at import: a refusal is `invalid_config`,
 * before any request is sent.
 *
 * It evaluates the AFPS §7.7 evaluation profile; `loginBlockIssues` refuses every other form.
 *
 * This is a manifest-author-driven HTTP request → an SSRF / exfil / DoS
 * surface. It is bounded by construction:
 *   - the request URL must match the integration's `authorizedUris` allowlist
 *     (the author's explicit trust boundary); when `allowAllUris` waives the
 *     allowlist, the SSRF blocklist (loopback/RFC1918/link-local/metadata)
 *     applies instead so there is never an unbounded in-process fetch;
 *   - per-request timeout; capped response body;
 *   - regex patterns run against a size-capped body (true ReDoS needs RE2 —
 *     documented residual; the body cap bounds worst-case input length);
 *   - `{{...}}` resolves ONLY `inputs` — never another connection's material;
 *     unresolved placeholders fail closed.
 *   - a declared `output` whose extractor produced an empty/undefined value
 *     fails closed too — never persist a silently-empty required value.
 *
 * Pure: no DB / Redis / sidecar. `fetchImpl` + `now` are injectable for tests.
 */

import { matchesAuthorizedUriSpec } from "@appstrate/afps-shared/authorized-uris";
import { substituteVars } from "../proxy-primitives.ts";
import { unresolvedPlaceholders } from "@appstrate/afps-runtime/resolvers";
import { decodeJwtPayload } from "@appstrate/core/jwt";
import { evaluateJsonPath } from "@appstrate/afps-shared/jsonpath";
import { parseCredentialRef } from "@appstrate/afps-shared/credential-template";
import {
  isJsonNumber,
  isJwtOutput,
  isSelectorOutput,
  loginBlockIssues,
  parseResponseExpression,
  simpleCriterionOperands,
  type SimpleOperand,
} from "@appstrate/afps-shared/runtime-expression";
import { resolveAndCheckHost, type HostResolver } from "@appstrate/core/ssrf";
import { isAllowedInternalIdpHost } from "../oauth-egress.ts";

interface LoginLimits {
  // Per-request timeout. Maps to the manifest field `connect.limits.request_timeout_ms`.
  stepTimeoutMs: number;
  maxResponseBytes: number;
}

const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  stepTimeoutMs: 15_000,
  maxResponseBytes: 1_000_000,
};

/**
 * An AFPS `connect.login.outputs` entry. Either an Arazzo runtime
 * expression string, an AFPS extractor object, or an Arazzo Selector Object
 * (`{ context, selector, type }`).
 */
type LoginOutput =
  | string
  | { from: "cookie"; name: string }
  | { from: "jwt"; token: string; path: string }
  | { from: "regex"; source: string; pattern: string; group?: number }
  | ArazzoSelectorObject;

/**
 * Arazzo Selector Object (§7.7, AFPS). `context` is an Arazzo runtime
 * expression yielding the document to query (typically `$response.body`);
 * `selector` is the type-specific query string.
 */
interface ArazzoSelectorObject {
  context: string;
  selector: string;
  type: "jsonpath" | "jsonpointer";
}

interface LoginRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  content_type?: string;
}

interface ArazzoCriterion {
  condition: string;
  /**
   * AFPS §7.7 Arazzo criterion type. When omitted (or `"simple"`), the
   * condition is an Arazzo runtime-expression equality (e.g.
   * `$statusCode == 200`, `$response.body#/status == "ok"`). When
   * `"jsonpath"` / `"regex"`, the criterion is evaluated against the
   * `context` document (defaulting to `$response.body`).
   */
  type?: "simple" | "jsonpath" | "regex";
  /**
   * Arazzo runtime expression naming the document the criterion runs against
   * (typically `$response.body`). Only honored for `jsonpath` / `regex`
   * criteria — `simple` evaluates against the runtime expression in its
   * `condition`.
   */
  context?: string;
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

interface LoginContext {
  /** Transient bootstrap secrets (e.g. password) for `{{...}}`. Never persisted by the engine. */
  inputs: Record<string, string>;
  /** Integration URL allowlist (global). The request URL must match unless allowAllUris. */
  authorizedUris: string[] | null;
  allowAllUris: boolean;
  fetchImpl?: typeof fetch;
  /** Injectable DNS resolver for the SSRF host check (tests). Prod omits it. */
  resolveHost?: HostResolver;
  now?: () => number;
}

interface LoginResult {
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
    /**
     * Standard `ErrorOptions`; pass `{ cause }` when raising this from a
     * `catch` so the underlying parse/URL error is not discarded.
     * `preserve-caught-error` cannot see custom classes, so this is on us.
     */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LoginError";
  }
}

/** The login response the criteria and outputs read; its body is parsed once. */
interface LoginResponse {
  status: number;
  headers: Headers;
  bodyText: string;
  /** The body as JSON, `undefined` when it is not JSON (`jsonError` then says why). */
  json: unknown;
  jsonError?: unknown;
}

function loginResponse(status: number, headers: Headers, bodyText: string): LoginResponse {
  try {
    return { status, headers, bodyText, json: JSON.parse(bodyText) };
  } catch (jsonError) {
    return { status, headers, bodyText, json: undefined, jsonError };
  }
}

/**
 * The value one side of a `simple` criterion compares: a literal as parsed, the status as a
 * number, a header or the whole body as text, a body pointer read against the parsed body.
 */
function evaluateOperand(operand: SimpleOperand, res: LoginResponse): unknown {
  if (operand.kind === "literal") return operand.value;
  const expr = operand.expression;
  if (expr.kind === "status") return res.status;
  if (expr.kind === "header") return res.headers.get(expr.name) ?? undefined;
  if (expr.pointer === undefined) return res.bodyText;
  return readJsonPointer(res.json, expr.pointer);
}

/**
 * Equality of Arazzo simple criteria: an absent value equals nothing; strings compare
 * case-insensitively (Arazzo); a number equals a string that is the same JSON number;
 * anything else compares strictly.
 */
function arazzoEquals(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === "number" && typeof right === "string") {
    return isJsonNumber(right) && left === Number(right);
  }
  if (typeof right === "number" && typeof left === "string") return arazzoEquals(right, left);
  return left === right;
}

/**
 * Evaluate one Arazzo Criterion (AFPS §7.7).
 *
 *  - `type` absent or `"simple"`: `condition` is `<lhs> == <rhs>`, the one form
 *    `loginBlockIssues` admits. LHS / RHS resolve via {@link evaluateOperand}.
 *  - `type: "jsonpath"`: `condition` is a JSONPath query evaluated against
 *    `context` (defaulting to `$response.body`). Passes when the result is
 *    a defined non-empty value (matches Arazzo's "non-empty result set"
 *    semantics for the single-value subset this engine supports).
 *  - `type: "regex"`: `condition` is a regex tested against `context`
 *    (defaulting to `$response.body`).
 */
function evaluateCriterion(criterion: ArazzoCriterion, res: LoginResponse): boolean {
  const condition = criterion.condition;
  const type = criterion.type ?? "simple";

  if (type === "simple") {
    const [lhs, rhs] = simpleCriterionOperands(condition)!.map((operand) =>
      evaluateOperand(operand, res),
    );
    return arazzoEquals(lhs, rhs);
  }

  if (type === "jsonpath") {
    if (res.json === undefined) return false;
    const result = evaluateJsonPath(res.json, condition);
    if (result === undefined || result === null) return false;
    if (typeof result === "string") return result.length > 0;
    if (Array.isArray(result)) return result.length > 0;
    return true;
  }

  return new RegExp(condition).test(regexSubject(criterion.context ?? "$response.body", res));
}

/**
 * Evaluate AFPS `success_criteria` (Arazzo, §7.7): omitted/`"simple"`
 * (runtime-expression equality), `"jsonpath"`, `"regex"`. When no criteria
 * are declared, defaults to the 2xx range.
 */
function passesSuccessCriteria(res: LoginResponse, criteria?: ArazzoCriterion[]): boolean {
  if (!criteria || criteria.length === 0) return res.status >= 200 && res.status < 300;
  return criteria.every((c) => evaluateCriterion(c, res));
}

/**
 * @internal — visible for tests. Returns true iff every Arazzo criterion
 * passes given the response shape. Same signature as the private
 * {@link passesSuccessCriteria}.
 */
export function evaluateSuccessCriteriaForTest(
  status: number,
  headers: Headers,
  bodyText: string,
  criteria: ArazzoCriterion[],
): boolean {
  return passesSuccessCriteria(loginResponse(status, headers, bodyText), criteria);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/**
 * RFC 6901 JSON-pointer read. `/a/b/0` → root.a.b[0]. Empty pointer ("") →
 * the document itself. Returns `undefined` on a miss: an array takes only a canonical index,
 * an object only an own member. Decodes `~1` → `/` and `~0` → `~` per RFC 6901.
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
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(tok)) return undefined;
      cur = cur[Number(tok)];
    } else if (isObject(cur) && Object.prototype.hasOwnProperty.call(cur, tok)) {
      cur = cur[tok];
    } else {
      return undefined;
    }
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
  // Enforce the cap WHILE streaming rather than buffering the whole body via
  // `arrayBuffer()` first — a hostile/oversized upstream response must not be
  // fully materialised in memory before the limit is checked. We abort as soon
  // as the cumulative byte count crosses `maxBytes` (holding at most one extra
  // chunk beyond the limit).
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new LoginError(`response body exceeds limit ${maxBytes}B`, "response_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** The text a regex criterion or extractor runs on: the whole body or one header. */
function regexSubject(expr: string, res: LoginResponse): string {
  const parsed = parseResponseExpression(expr)!;
  return parsed.kind === "header" ? (res.headers.get(parsed.name) ?? "") : res.bodyText;
}

const isBodyExpression = (expr: string) => parseResponseExpression(expr)?.kind === "body";

/** Whether a criterion or an output reads the response body (a jwt reads another output). */
function readsBody(login: LoginRequestSpec): boolean {
  const criteria = (login.success_criteria ?? []).some((c) => {
    const type = c.type ?? "simple";
    if (type === "jsonpath") return true;
    if (type === "regex") return isBodyExpression(c.context ?? "$response.body");
    return simpleCriterionOperands(c.condition)!.some(
      (o) => o.kind === "expression" && o.expression.kind === "body",
    );
  });
  return (
    criteria ||
    Object.values(login.outputs ?? {}).some((out) => {
      if (typeof out === "string") return isBodyExpression(out);
      if (isSelectorOutput(out)) return true;
      return out.from === "regex" && isBodyExpression(out.source);
    })
  );
}

/** The response body as JSON; the only document a selector or body pointer reads. */
function bodyJson(res: LoginResponse, name: string): unknown {
  if (res.json === undefined) {
    throw new LoginError(`'${name}' json parse failed`, "extract_failed", { cause: res.jsonError });
  }
  return res.json;
}

/**
 * Apply one AFPS `outputs` expression. `scope` carries values already
 * extracted in this pass (for jwt `token` resolution). Returns `undefined`
 * when its target is absent — the caller fails closed on `undefined`/empty.
 */
function applyOutput(
  out: LoginOutput,
  res: LoginResponse,
  scope: Record<string, string>,
  name: string,
): string | undefined {
  if (typeof out === "string") {
    const expr = parseResponseExpression(out)!;
    if (expr.kind === "status") return String(res.status);
    if (expr.kind === "header") return res.headers.get(expr.name) ?? undefined;
    if (expr.pointer === undefined) return res.bodyText;
    const v = readJsonPointer(bodyJson(res, name), expr.pointer);
    return v === undefined ? undefined : stringifyValue(v);
  }

  // Arazzo Selector Object form (`{ context, selector, type }`).
  if (isSelectorOutput(out)) {
    const doc = bodyJson(res, name);
    const v =
      out.type === "jsonpointer"
        ? readJsonPointer(doc, out.selector)
        : evaluateJsonPath(doc, out.selector);
    return v === undefined ? undefined : stringifyValue(v);
  }

  switch (out.from) {
    case "cookie":
      return parseSetCookie(res.headers, out.name);
    case "jwt": {
      const token = scope[parseCredentialRef(out.token)!];
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
      const m = new RegExp(out.pattern).exec(regexSubject(out.source, res));
      if (!m) return undefined;
      return m[out.group ?? 1] ?? undefined;
    }
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
  const [issue] = loginBlockIssues(login);
  if (issue) {
    throw new LoginError(
      `connect.login.${issue.path.join(".")}: ${issue.message}`,
      "invalid_config",
    );
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

  // Fail closed on a `{{name}}` no input supplies (a typo'd placeholder must never
  // be sent literally upstream).
  const unresolved = [
    login.request.url,
    login.request.body ?? "",
    ...Object.values(login.request.headers ?? {}),
  ].flatMap((template) => unresolvedPlaceholders(template, vars));
  if (unresolved.length > 0) {
    throw new LoginError(
      `unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`,
      "unresolved_placeholder",
    );
  }

  // URL gate. This engine runs in the platform process (not the
  // credential-isolating sidecar), so the request URL is a manifest-authored
  // SSRF surface. The SSRF blocklist ALWAYS applies — an `authorizedUris`
  // allowlist may only *narrow* the reachable surface, never widen it past the
  // loopback/RFC1918/link-local/cloud-metadata blocklist. (A manifest that
  // allowlists an internal host must not be able to steer the platform there.)
  //
  // Exception: a host the OPERATOR has explicitly declared trusted via
  // `EGRESS_ALLOW_INTERNAL_HOSTS` (a self-hosted deployment whose login
  // endpoint legitimately lives on a private address). Unset in production by
  // default, so every internal host stays blocked there.
  let loginUrl: URL;
  try {
    loginUrl = new URL(url);
  } catch (err) {
    // The `url_not_allowed` reason is shared with the real blocklist rejection
    // below, so this branch's message describes THAT and not what happened
    // here — the URL did not parse. The TypeError is the only thing in the
    // thrown error that says so. (Message and reason left as-is: both are
    // matched by callers; the cause is the additive half.)
    throw new LoginError("url targets a blocked/internal address", "url_not_allowed", {
      cause: err,
    });
  }
  // Scheme floor: only http(s) may leave the engine. The literal `isBlockedUrl`
  // gate this check replaced also rejected non-http(s) schemes; the DNS-aware
  // host check below is host-only, so keep the floor explicit — an `ftp:` /
  // `file:` / `gopher:` URL must fail here, not later as a generic fetch error.
  if (loginUrl.protocol !== "https:" && loginUrl.protocol !== "http:") {
    throw new LoginError("url targets a blocked/internal address", "url_not_allowed");
  }
  const loginHost = loginUrl.hostname;
  // DNS-aware check (resolves the host, blocks if ANY resolved address is
  // private/link-local/loopback/metadata) — the literal `isBlockedUrl` used
  // before was string-only, so `evil.example.com → 169.254.169.254` (DNS
  // rebind) sailed through on this credential-bearing path. Matches the OAuth
  // egress paths. Operator-trusted internal hosts opt out.
  if (!isAllowedInternalIdpHost(loginHost)) {
    const hostCheck = await resolveAndCheckHost(loginHost, { resolve: ctx.resolveHost });
    if (hostCheck.blocked) {
      throw new LoginError("url targets a blocked/internal address", "url_not_allowed");
    }
  }
  // When an allowlist is present (`!allowAllUris`), the URL must additionally
  // match one of the author's explicit, auditable `authorizedUris` patterns.
  if (!ctx.allowAllUris) {
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

  const outputEntries = Object.entries(login.outputs ?? {});
  // Read only a body something reads: a large page behind a status-only login must not fail.
  const response = loginResponse(
    res.status,
    res.headers,
    readsBody(login) ? await readBoundedText(res, limits.maxResponseBytes) : "",
  );

  if (!passesSuccessCriteria(response, login.success_criteria)) {
    // Never log/echo the body — only the status.
    throw new LoginError(`unexpected status ${res.status}`, "bad_status");
  }

  // Extract in two passes so a `jwt` extractor can reference any other
  // same-request value regardless of key order. We can't rely on insertion
  // order: the manifest is persisted as JSONB, which does NOT preserve key
  // order, so the decrypted `outputs` map comes back reordered. Pass 1 runs
  // every self-contained expression (body/header/cookie/regex/statusCode);
  // pass 2 runs `jwt`, whose `token` names another extracted value.
  // No prototype: a jwt `token` never resolves to an inherited property.
  const extracted: Record<string, string> = Object.create(null);
  for (const [name, out] of outputEntries) {
    if (isJwtOutput(out)) continue;
    const v = applyOutput(out, response, extracted, name);
    if (v !== undefined) extracted[name] = v;
  }
  for (const [name, out] of outputEntries) {
    if (!isJwtOutput(out)) continue;
    const v = applyOutput(out, response, extracted, name);
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
