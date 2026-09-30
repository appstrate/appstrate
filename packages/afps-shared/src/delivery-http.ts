// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS `delivery.http` block → resolver-config projection — the SINGLE
 * source of truth, used by both `@appstrate/connect`'s `afps-delivery.ts`
 * and `@appstrate/afps-runtime`'s `resolvers/integration-api-call.ts`.
 *
 * The AFPS `auths.{key}.delivery.http` block (snake_case) is:
 *
 *   { in: "header", name }              header channel + name
 *   { prefix }                          value prefix, e.g. "Bearer "
 *   { value: "{$credential.<field>}" }  value template
 *   { value: "<template>", encoding }   base64-encoded template
 *   { allow_server_override }           strip caller override when false
 *
 * The value is a TEMPLATE referencing credential fields via the
 * `{$credential.<field>}` syntax. This module is a pure shape projection: it
 * maps the AFPS snake_case block onto the resolver `HttpDeliveryConfig` shape,
 * carrying the template verbatim (`./credential-template` renders it). The per-auth-type
 * default table is below; the rendering and the base64 encoding live in the resolver engine
 * (`@appstrate/afps-runtime/resolvers:resolveHttpDelivery`) — they are NOT
 * re-implemented here.
 */

/**
 * Resolver config consumed by `resolveHttpDelivery`
 * (`@appstrate/afps-runtime/resolvers`). This zero-dep package is the single
 * source of truth for the shape; afps-runtime re-exports it.
 */
export interface HttpDeliveryConfig {
  headerName?: string;
  headerPrefix?: string;
  /** A `{$credential.<field>}` template, base64-encoded after rendering when asked. */
  valueFrom?: { template: string; encoding?: "base64" };
  allowServerOverride?: boolean;
}

/**
 * Subset of the AFPS `auths.{key}.delivery.http` block (snake_case). `value`
 * is a template; `{$credential.<field>}` references resolve against the auth's
 * credential bag.
 */
export interface AfpsHttpDelivery {
  /** Delivery channel discriminant — always `"header"` for http delivery. */
  in?: "header";
  /** Header name. */
  name?: string;
  /** Header value prefix, e.g. `"Bearer "`. */
  prefix?: string;
  /** Value template with `{$credential.<field>}` refs. */
  value?: string;
  /** Optional post-render encoding — base64 of the rendered value. */
  encoding?: "base64";
  /** Mirrors manifest; default `false` → proxy strips caller overrides. */
  allow_server_override?: boolean;
}

/**
 * Project an AFPS `delivery.http` block (snake_case) onto the resolver's
 * {@link HttpDeliveryConfig}. Returns `undefined` when no `delivery.http` block
 * is declared, so the resolver applies its own per-auth-type defaults.
 */
export function projectHttpDeliveryConfig(
  http: AfpsHttpDelivery | undefined,
): HttpDeliveryConfig | undefined {
  if (!http) return undefined;
  const cfg: HttpDeliveryConfig = {};
  if (typeof http.name === "string") cfg.headerName = http.name;
  if (typeof http.prefix === "string") cfg.headerPrefix = http.prefix;
  if (typeof http.allow_server_override === "boolean") {
    cfg.allowServerOverride = http.allow_server_override;
  }
  if (typeof http.value === "string") {
    cfg.valueFrom =
      http.encoding === "base64"
        ? { template: http.value, encoding: "base64" }
        : { template: http.value };
  }
  return cfg;
}

/**
 * Auth-type defaults for `delivery.http` (AFPS §4.1.4), written as the manifest
 * would write them. `resolveHttpDelivery` (`@appstrate/afps-runtime/resolvers`)
 * applies them.
 */
export const AUTH_TYPE_HTTP_DEFAULTS: Readonly<
  Record<
    string,
    Required<Pick<HttpDeliveryConfig, "headerName" | "headerPrefix">> & HttpDeliveryConfig
  >
> = {
  oauth2: {
    headerName: "Authorization",
    headerPrefix: "Bearer ",
    valueFrom: { template: "{$credential.access_token}" },
  },
  api_key: {
    headerName: "X-Api-Key",
    headerPrefix: "",
    valueFrom: { template: "{$credential.api_key}" },
  },
  basic: {
    headerName: "Authorization",
    headerPrefix: "Basic ",
    valueFrom: { template: "{$credential.username}:{$credential.password}", encoding: "base64" },
  },
  custom: { headerName: "", headerPrefix: "" },
};

/**
 * Whether an auth's HTTP delivery names a header the proxy fills with a
 * credential itself: an explicit `delivery.http.name`, else its type's default.
 * The manifest-level form of `resolveHttpDelivery` returning a plan.
 */
export function injectsHttpCredential(
  authType: string,
  http: AfpsHttpDelivery | undefined,
): boolean {
  const name = projectHttpDeliveryConfig(http)?.headerName;
  return (name ?? AUTH_TYPE_HTTP_DEFAULTS[authType]?.headerName ?? "").length > 0;
}

/**
 * Header names whose value is an RFC 9110 `credentials` production — an auth
 * scheme token, one SP, then the credentials. Only in these positions is a
 * bare token prefix a defect; anywhere else (`Cookie: session=`) it is an
 * ordinary literal.
 */
const AUTH_SCHEME_HEADERS = new Set(["authorization", "proxy-authorization"]);

/** RFC 9110 `token` grammar — matches a prefix that is nothing but a scheme. */
const BARE_AUTH_SCHEME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * True when `prefix` is nothing but an auth-scheme token AND `headerName` is a
 * position whose value is an RFC 9110 `credentials` production.
 *
 * `prefix` is a LITERAL prepended to the rendered credential (AFPS §7.6), so a
 * bare `"Bearer"` renders `Authorization: BearerTOKEN` — a malformed credential
 * every upstream answers with a 401 that names nothing. The injector
 * (`@appstrate/afps-runtime`'s `planHttpDeliveryInjection`) concatenates
 * verbatim and repairs nothing, so every path that accepts an author-written
 * prefix must refuse the bare form up front instead. This is the one grammar
 * those gates share: the integration manifest validator
 * (`@appstrate/core/integration`, install time) and the portable runtime's
 * local creds file (`resolvers/integration-api-call.ts`, load time).
 *
 * Callers pass the EFFECTIVE header name — the one that will actually be sent,
 * after their own defaulting has been applied.
 */
export function isBareAuthSchemePrefix(headerName: string, prefix: string): boolean {
  return AUTH_SCHEME_HEADERS.has(headerName.toLowerCase()) && BARE_AUTH_SCHEME.test(prefix);
}
