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
import { hostLiterallyAllowlisted, matchesAuthorizedUriSpec } from "./http-call-core.ts";
import { cookieScope, type CookieScope } from "./cookie-jar.ts";

/** Deadline of one upstream `api_call` exchange, body included, on every path. */
export const API_CALL_TIMEOUT_MS = 30_000;

/**
 * A redirect hop refused: off the allowlist, blocked by the SSRF gate, or with no DNS answer. The
 * message names its host, credential values scrubbed, never the URL (`?token=…`).
 */
export class RedirectBlockedError extends Error {
  constructor(
    public readonly reason: "ssrf" | "unauthorized" | "unresolvable",
    redactedHost: string,
  ) {
    super(`Redirect blocked (${reason}): host=${redactedHost}`);
    this.name = "RedirectBlockedError";
  }
}

/** The initial target refused before any byte was sent (`unresolvable`: DNS gave no answer). */
export class PreflightError extends Error {
  constructor(
    public readonly reason: "ssrf" | "not_authorized" | "unresolvable",
    message: string,
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

/** Why an `api_call` exchange failed, on every path (platform proxy, sidecar, CLI). */
export interface ApiCallFailureClass {
  kind: "not_authorized" | "ssrf" | "unresolvable" | "timeout" | "transport";
  /** A redirect hop was refused, not the initial target. */
  redirect: boolean;
  /** The refusal's message (hosts redacted); a transport error's own message. */
  message: string;
  code?: string;
}

/** Classify what {@link fetchApiCall} threw; each path maps the class to its own output. */
export function classifyApiCallFailure(err: unknown): ApiCallFailureClass {
  if (err instanceof PreflightError) {
    return { kind: err.reason, redirect: false, message: err.message };
  }
  if (err instanceof RedirectBlockedError) {
    const kind = err.reason === "unauthorized" ? "not_authorized" : err.reason;
    return { kind, redirect: true, message: err.message };
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
  /** The manifest's declared (unrendered) list: only its literal hosts share cookies or skip SSRF. */
  declaredUris: readonly string[];
  /** `credentialUrlPolicy(...).allowAllUris` — never the raw manifest flag. */
  allowAllUris: boolean;
  /** Names of the headers that carry a credential (injected or substituted). */
  credentialHeaders: readonly string[];
  /**
   * Hosts exempt from the SSRF gate. Omitted = the hosts `declaredUris` names literally (the
   * manifest's topology), none under `allowAllUris`, where the caller picks the host.
   */
  trustedHost?: (hostname: string) => boolean;
  /** The caller's cookie view; omitted = a jar living for this call's redirect chain only. */
  cookies?: CookieScope;
  integrationId: string;
  /** Transport override (tests): disables the address pin. Omitted = pinned global `fetch`. */
  fetchFn?: typeof fetch;
  resolveHost?: HostResolver;
  /** Credential values scrubbed from the hosts a refusal or a log line names. */
  credentialFields: Readonly<Record<string, string>>;
  logger?: ApiCallLogger;
}

/**
 * Send one `api_call` upstream. Throws {@link PreflightError} (initial target refused, nothing
 * sent), {@link RedirectBlockedError} (a hop refused) or the scrubbed transport error. A
 * `ReadableStream` body cannot be replayed, so its redirect is returned unfollowed.
 */
export async function fetchApiCall(opts: FetchApiCallOptions): Promise<GuardedFetchResult> {
  const fields = opts.credentialFields;
  const { authorizedUris, declaredUris, allowAllUris } = opts;
  if (!URL.canParse(opts.url)) throw new PreflightError("ssrf", "Invalid target URL");
  const gated = !allowAllUris;
  const inAllowlist = (url: URL) =>
    authorizedUris.some((p) => matchesAuthorizedUriSpec(p, url.href));
  const warn = (message: string, hop: number, host: string) =>
    opts.logger?.warn(message, { integrationId: opts.integrationId, hop, host });

  const callerSignal = opts.init.signal;
  const signal = AbortSignal.any([
    AbortSignal.timeout(API_CALL_TIMEOUT_MS),
    ...(callerSignal ? [callerSignal] : []),
  ]);

  try {
    return await guardedFetchChain(
      opts.url,
      { ...opts.init, signal },
      {
        ...(gated
          ? {
              validateHop: (url: URL, hop: number) => {
                if (inAllowlist(url)) return;
                if (hop === 0) {
                  // The declared entries: a rendered one may be a secret (an exact webhook URL).
                  throw new PreflightError(
                    "not_authorized",
                    `URL not in authorized_uris allowlist. Allowed: ${declaredUris.join(", ")}`,
                  );
                }
                const host = redactCredentialHost(url.href, fields);
                warn("Redirect refused (not in authorizedUris)", hop, host);
                throw new RedirectBlockedError("unauthorized", host);
              },
              forwardCredentials: inAllowlist,
            }
          : {}),
        allowHost:
          opts.trustedHost ??
          ((hostname: string) =>
            !allowAllUris && hostLiterallyAllowlisted(`http://${hostname}/`, declaredUris)),
        sensitiveHeaders: opts.credentialHeaders,
        cookies:
          opts.cookies ?? cookieScope(new Map(), opts.integrationId, gated ? declaredUris : null),
        followRedirects: !(opts.init.body instanceof ReadableStream),
        // A Bun `proxy` resolves the name itself and matches its ACLs on it.
        pinToResolvedAddress: !(opts.init as { proxy?: string }).proxy,
        ...(opts.fetchFn ? { fetchImpl: opts.fetchFn } : {}),
        ...(opts.resolveHost ? { resolve: opts.resolveHost } : {}),
      },
    );
  } catch (err) {
    if (err instanceof PreflightError || err instanceof RedirectBlockedError) throw err;
    if (!(err instanceof SsrfBlockedError)) throw scrubTransportError(err, fields);
    const host = redactCredentialHost(`http://${err.host}/`, fields);
    if (err.reason === "too-many-redirects") {
      // No `cause`: the guard's error names the unredacted host (a templated one is a secret).
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Too many redirects (>${DEFAULT_MAX_REDIRECTS}) starting at ${redactCredentialHost(opts.url, fields)}`,
      );
    }
    if (err.reason === "resolution-failed") {
      if (err.hop > 0) throw new RedirectBlockedError("unresolvable", host);
      throw new PreflightError("unresolvable", `Target host could not be resolved (${host})`);
    }
    if (err.hop > 0) {
      warn("Redirect refused (SSRF)", err.hop, host);
      throw new RedirectBlockedError("ssrf", host);
    }
    throw new PreflightError("ssrf", "URL targets a blocked network range");
  }
}
