// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The outbound half of every `api_call` path (platform proxy, sidecar, CLI):
 * allowlist + SSRF gate on every hop with the connection pinned, credentials
 * kept only across allowlisted origins, per-hop cookie capture, one deadline.
 * Credential sourcing, injection, the 401 retry and serving stay per path.
 */

import {
  DEFAULT_MAX_REDIRECTS,
  guardedFetchChain,
  SsrfBlockedError,
  type GuardedFetchResult,
} from "@appstrate/afps-shared/guarded-fetch";
import type { HostResolver } from "@appstrate/afps-shared/ssrf-dns";
import {
  assertHttpFieldValue,
  InvalidHeaderValueError,
} from "@appstrate/afps-shared/delivery-http";
import {
  hostLiterallyAllowlisted,
  matchesAuthorizedUriSpec,
} from "@appstrate/afps-shared/authorized-uris";
import { cookieScope, type CookieScope } from "./cookie-jar.ts";

/** Deadline of one upstream `api_call` exchange, body included, on every path. */
export const API_CALL_TIMEOUT_MS = 30_000;

/** RFC 9110 §7.6.1 connection-specific headers plus the proxy-auth pair: never forwarded by a proxy. */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Caller headers minus Host, Content-Length, hop-by-hop and `Connection`-named ones (a credential
 * excepted). The one caller-header rule. Throws {@link InvalidHeaderValueError} on a value that is
 * no HTTP field value, before `Headers` can quote it in its own TypeError. */
export function forwardableHeaders(
  init: Pick<RequestInit, "headers">,
  credentialHeaders: readonly string[] = [],
): Headers {
  const given =
    init.headers instanceof Headers
      ? [...init.headers]
      : Array.isArray(init.headers)
        ? init.headers
        : Object.entries(init.headers ?? {});
  for (const [name, value] of given) assertHttpFieldValue(String(name), String(value));
  const headers = new Headers(init.headers);
  const credential = new Set(credentialHeaders.map((h) => h.toLowerCase()));
  const named = new Set(
    (headers.get("connection") ?? "").split(",").map((t) => t.trim().toLowerCase()),
  );
  for (const name of [...headers.keys()]) {
    if (
      name === "host" ||
      name === "content-length" ||
      HOP_BY_HOP_HEADERS.has(name) ||
      (named.has(name) && !credential.has(name))
    ) {
      headers.delete(name);
    }
  }
  return headers;
}

/**
 * A target refused: off the allowlist, blocked by the SSRF gate, or with no DNS answer
 * (`unresolvable`). A redirect's message names its host, credential values scrubbed, never the URL
 * (`?token=…`).
 */
export class ApiCallRefusedError extends Error {
  constructor(
    public readonly kind: "ssrf" | "not_authorized" | "unresolvable",
    message: string,
    /** A redirect hop was refused; `false` is the initial target, before any byte was sent. */
    public readonly redirect = false,
  ) {
    super(message);
    this.name = "ApiCallRefusedError";
  }
}

/** Why an `api_call` exchange failed, on every path (platform proxy, sidecar, CLI). */
export interface ApiCallFailureClass {
  /** `invalid_header`: a header value is no HTTP field value; nothing was sent. */
  kind: "not_authorized" | "ssrf" | "unresolvable" | "invalid_header" | "timeout" | "transport";
  /** A redirect hop was refused, not the initial target. */
  redirect: boolean;
  /** The refusal's message (hosts redacted); a transport error's own message. */
  message: string;
  code?: string;
}

/** Classify what {@link fetchApiCall} threw; each path maps the class to its own output. */
export function classifyApiCallFailure(err: unknown): ApiCallFailureClass {
  if (err instanceof ApiCallRefusedError) {
    return { kind: err.kind, redirect: err.redirect, message: err.message };
  }
  if (err instanceof InvalidHeaderValueError) {
    return { kind: "invalid_header", redirect: false, message: err.message };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "TimeoutError")
    return { kind: "timeout", redirect: false, message: error.message };
  const code = (error as { code?: unknown }).code;
  return {
    kind: "transport",
    redirect: false,
    message: error.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}

/** Extract hostname for audit logs, never throwing. */
function redactHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<unparseable>";
  }
}

/** Each credential value, raw or percent-encoded, → `{{field}}`; longest first (overlaps). */
function redactCredentialValues(value: string, fields: Readonly<Record<string, string>>): string {
  const needles: Array<[string, string]> = [];
  for (const [name, fieldValue] of Object.entries(fields)) {
    if (fieldValue.length === 0) continue;
    needles.push([fieldValue, name]);
    const encoded = encodeURIComponent(fieldValue);
    if (encoded !== fieldValue) needles.push([encoded, name]);
  }
  needles.sort((a, b) => b[0].length - a[0].length);
  let out = value;
  for (const [needle, name] of needles) out = out.split(needle).join(`{{${name}}}`);
  return out;
}

/** {@link redactHost}, credential values scrubbed (lowercased, as WHATWG lowercases hosts). */
export function redactCredentialHost(
  url: string,
  fields: Readonly<Record<string, string>>,
): string {
  const lowered = Object.fromEntries(
    Object.entries(fields).map(([name, v]) => [name, v.toLowerCase()]),
  );
  return redactCredentialValues(redactHost(url), lowered);
}

/** Every URL cut to its redacted host, then credential values scrubbed. */
function redactCredentialMessage(
  message: string,
  fields: Readonly<Record<string, string>>,
): string {
  return redactCredentialValues(
    message.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactCredentialHost(url, fields)),
    fields,
  );
}

/**
 * `err` as-is when `fields` is empty (untemplated call); otherwise a same-`name` Error with the
 * message scrubbed and nothing else — Bun keeps the full URL on `.path` even when the message has none.
 */
function scrubTransportError(err: unknown, fields: Readonly<Record<string, string>>): unknown {
  if (!(err instanceof Error) || Object.keys(fields).length === 0) return err;
  const clean = new Error(redactCredentialMessage(err.message, fields));
  clean.name = err.name;
  return clean;
}

interface ApiCallLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface FetchApiCallOptions {
  url: string;
  /** Method, headers (credential already injected), body, and optionally the caller's signal. */
  init: RequestInit;
  /** The connection's rendered `authorized_uris`: what a target and every hop must match. */
  authorizedUris: readonly string[];
  /** The manifest's declared (unrendered) list: only its literal hosts share cookies or can skip SSRF. */
  declaredUris: readonly string[];
  /** `credentialUrlPolicy(...).allowAllUris` — never the raw manifest flag. */
  allowAllUris: boolean;
  /** Names of the headers that carry a credential (injected or substituted). */
  credentialHeaders: readonly string[];
  /**
   * Whether the operator of the network this call leaves from lets it reach an internal address
   * behind `hostname`. A host skips the SSRF gate only when this accepts it AND `declaredUris`
   * names it literally, never under `allowAllUris`: the operator vouches for the host, the
   * manifest for the call. Same rule on a redirect hop. A host only a glob or a rendered entry
   * matches is always gated.
   */
  internalHost: (hostname: string) => boolean;
  /** The caller's cookie view; omitted = a jar living for this call's redirect chain only. */
  cookies?: CookieScope;
  integrationId: string;
  /** Transport override (tests): disables the address pin. Omitted = pinned global `fetch`. */
  fetchFn?: typeof fetch;
  resolveHost?: HostResolver;
  /** Byte length of a `ReadableStream` body from a trusted source (the file size, the request's own
   * framing), sent as its Content-Length. Omitted = chunked. A caller's Content-Length never is. */
  bodyLength?: number;
  /** The target's host as its template names it (`templateHost`): what a message about it echoes. */
  targetHost: string;
  /** Credential values scrubbed from the redirect hosts and transport errors a message names. */
  credentialFields: Readonly<Record<string, string>>;
  logger?: ApiCallLogger;
}

/**
 * Send one `api_call` upstream. Throws {@link ApiCallRefusedError} (the initial target or a hop
 * refused), {@link InvalidHeaderValueError} (nothing sent) or the scrubbed transport error. A
 * `ReadableStream` body cannot be replayed, so its redirect is returned unfollowed.
 */
export async function fetchApiCall(opts: FetchApiCallOptions): Promise<GuardedFetchResult> {
  const fields = opts.credentialFields;
  const { authorizedUris, declaredUris, allowAllUris } = opts;
  if (!URL.canParse(opts.url)) throw new ApiCallRefusedError("ssrf", "Invalid target URL");
  const gated = !allowAllUris;
  const inAllowlist = (url: URL) =>
    authorizedUris.some((p) => matchesAuthorizedUriSpec(p, url.href));
  const warn = (message: string, hop: number, host: string) =>
    opts.logger?.warn(message, { integrationId: opts.integrationId, hop, host });
  const redirectRefused = (kind: ApiCallRefusedError["kind"], host: string) =>
    new ApiCallRefusedError(
      kind,
      `Redirect blocked (${kind === "not_authorized" ? "unauthorized" : kind}): host=${host}`,
      true,
    );

  const callerSignal = opts.init.signal;
  const signal = AbortSignal.any([
    AbortSignal.timeout(API_CALL_TIMEOUT_MS),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  try {
    const headers = forwardableHeaders(opts.init, opts.credentialHeaders);
    const streamed = opts.init.body instanceof ReadableStream;
    if (streamed && opts.bodyLength !== undefined) {
      headers.set("content-length", String(opts.bodyLength));
    }
    return await guardedFetchChain(
      opts.url,
      { ...opts.init, headers, signal },
      {
        ...(gated
          ? {
              validateHop: (url: URL, hop: number) => {
                if (inAllowlist(url)) return;
                if (hop === 0) {
                  // The declared entries: a rendered one may be a secret (an exact webhook URL).
                  throw new ApiCallRefusedError(
                    "not_authorized",
                    `URL not in authorized_uris allowlist. Allowed: ${declaredUris.join(", ")}`,
                  );
                }
                const host = redactCredentialHost(url.href, fields);
                warn("Redirect refused (not in authorizedUris)", hop, host);
                throw redirectRefused("not_authorized", host);
              },
              forwardCredentials: inAllowlist,
            }
          : {}),
        allowHost: (hostname: string) =>
          !allowAllUris &&
          hostLiterallyAllowlisted(`http://${hostname}/`, declaredUris) &&
          opts.internalHost(hostname),
        sensitiveHeaders: opts.credentialHeaders,
        cookies:
          opts.cookies ?? cookieScope(new Map(), opts.integrationId, gated ? declaredUris : null),
        followRedirects: !streamed,
        // A Bun `proxy` resolves the name itself and matches its ACLs on it.
        pinToResolvedAddress: !(opts.init as { proxy?: string }).proxy,
        ...(opts.fetchFn ? { fetchImpl: opts.fetchFn } : {}),
        ...(opts.resolveHost ? { resolve: opts.resolveHost } : {}),
      },
    );
  } catch (err) {
    if (err instanceof ApiCallRefusedError || err instanceof InvalidHeaderValueError) throw err;
    if (!(err instanceof SsrfBlockedError)) throw scrubTransportError(err, fields);
    const host = redactCredentialHost(`http://${err.host}/`, fields);
    if (err.reason === "too-many-redirects") {
      // No `cause`: the guard's error names the unredacted host (a templated one is a secret).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Too many redirects (>${DEFAULT_MAX_REDIRECTS}) starting at ${opts.targetHost}`,
      );
    }
    if (err.reason === "resolution-failed") {
      if (err.hop > 0) throw redirectRefused("unresolvable", host);
      throw new ApiCallRefusedError(
        "unresolvable",
        `Target host could not be resolved (${opts.targetHost})`,
      );
    }
    if (err.hop > 0) {
      warn("Redirect refused (SSRF)", err.hop, host);
      throw redirectRefused("ssrf", host);
    }
    // Operators read this to find the host an internal API needs listed (`internalHost`).
    warn("Target refused (SSRF)", 0, opts.targetHost);
    throw new ApiCallRefusedError("ssrf", "URL targets a blocked network range");
  }
}
