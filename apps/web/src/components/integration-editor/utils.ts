// SPDX-License-Identifier: Apache-2.0

/**
 * Read/write helpers for the structured integration-editor sections. Each
 * operates on the raw AFPS manifest record (snake_case wire shape) and returns
 * a NEW manifest. Writers MERGE form-owned fields onto the existing raw
 * sub-objects so fields the forms don't surface (`connect`, `identity_claims`,
 * `_meta`, `delivery.env`/`files`, `scope_catalog.implies`, …) survive an edit
 * of an imported manifest — only the JSON tab can touch those, but a structured
 * edit must never silently drop them. Returning fresh objects keeps React
 * Query's dirty detection (JSON.stringify) correct.
 */

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ─── Source ─────────────────────────────────────────────────

export type SourceKind = "remote" | "local" | "none";

export interface SourceState {
  kind: SourceKind;
  remoteUrl: string;
  remoteTransport: string;
  serverName: string;
  serverVersion: string;
}

export function getSource(manifest: Rec): SourceState {
  const source = asRec(manifest.source);
  const kind = (source.kind as SourceKind) ?? "remote";
  const remote = asRec(source.remote);
  const server = asRec(source.server);
  return {
    kind: kind === "local" || kind === "none" ? kind : "remote",
    remoteUrl: typeof remote.url === "string" ? remote.url : "",
    remoteTransport: typeof remote.transport === "string" ? remote.transport : "streamable-http",
    serverName: typeof server.name === "string" ? server.name : "",
    serverVersion: typeof server.version === "string" ? server.version : "",
  };
}

export function setSource(manifest: Rec, s: SourceState): Rec {
  // Merge onto the existing source so changing kind doesn't discard sibling
  // keys (`_meta`, headers, …) the forms don't surface. On a kind switch we
  // drop the now-irrelevant variant block but keep everything else.
  const base = asRec(manifest.source);
  const source: Rec = { ...base, kind: s.kind };
  if (s.kind === "remote") {
    source.remote = { ...asRec(base.remote), url: s.remoteUrl, transport: s.remoteTransport };
    delete source.server;
  } else if (s.kind === "local") {
    source.server = { ...asRec(base.server), name: s.serverName, version: s.serverVersion };
    delete source.remote;
  } else {
    delete source.remote;
    delete source.server;
  }
  return { ...manifest, source };
}

// ─── Auths ──────────────────────────────────────────────────

export type AuthType = "api_key" | "oauth2" | "basic" | "custom";

export interface ScopeCatalogEntry {
  value: string;
  label?: string;
  description?: string;
}

export interface AuthState {
  key: string;
  type: AuthType;
  authorizedUris: string[];
  allowAllUris: boolean;
  // delivery.http (in=header)
  deliveryHeaderName: string;
  deliveryHeaderPrefix: string;
  deliveryHeaderValue: string;
  // oauth2
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  scopeCatalog: ScopeCatalogEntry[];
  // api_key / basic / custom — credential field names (→ required string props)
  credentialFields: string[];
}

const KNOWN_AUTH_TYPES: AuthType[] = ["api_key", "oauth2", "basic", "custom"];

function readAuth(key: string, raw: Rec): AuthState {
  const type = KNOWN_AUTH_TYPES.includes(raw.type as AuthType) ? (raw.type as AuthType) : "api_key";
  const delivery = asRec(raw.delivery);
  const http = asRec(delivery.http);
  const credentials = asRec(raw.credentials);
  const credSchema = asRec(credentials.schema);
  const credProps = asRec(credSchema.properties);
  const scopeCatalogRaw = Array.isArray(raw.scope_catalog) ? raw.scope_catalog : [];
  return {
    key,
    type,
    authorizedUris: asStringArray(raw.authorized_uris),
    allowAllUris: raw.allow_all_uris === true,
    deliveryHeaderName: typeof http.name === "string" ? http.name : "",
    deliveryHeaderPrefix: typeof http.prefix === "string" ? http.prefix : "",
    deliveryHeaderValue: typeof http.value === "string" ? http.value : "",
    authorizationEndpoint:
      typeof raw.authorization_endpoint === "string" ? raw.authorization_endpoint : "",
    tokenEndpoint: typeof raw.token_endpoint === "string" ? raw.token_endpoint : "",
    defaultScopes: asStringArray(raw.default_scopes),
    scopeCatalog: scopeCatalogRaw.map((e) => {
      const entry = asRec(e);
      return {
        value: typeof entry.value === "string" ? entry.value : "",
        label: typeof entry.label === "string" ? entry.label : undefined,
        description: typeof entry.description === "string" ? entry.description : undefined,
      };
    }),
    credentialFields: Object.keys(credProps),
  };
}

export function getAuths(manifest: Rec): AuthState[] {
  const auths = asRec(manifest.auths);
  return Object.entries(auths).map(([key, raw]) => readAuth(key, asRec(raw)));
}

/** Preserve `scope_catalog[].implies` (+ any other per-entry fields) by merging
 * each form entry onto the matching base entry by `value`. */
function mergeScopeCatalog(baseRaw: unknown, entries: ScopeCatalogEntry[]): Rec[] {
  const baseArr = Array.isArray(baseRaw) ? baseRaw : [];
  const byValue = new Map<string, Rec>();
  for (const e of baseArr) {
    const r = asRec(e);
    if (typeof r.value === "string") byValue.set(r.value, r);
  }
  return entries.map((e) => {
    const out: Rec = { ...(byValue.get(e.value) ?? {}), value: e.value };
    if (e.label) out.label = e.label;
    else delete out.label;
    if (e.description) out.description = e.description;
    else delete out.description;
    return out;
  });
}

/** Rebuild credentials.schema from the form's field-name list while preserving
 * each surviving property's existing definition (description, format, …). */
function mergeCredentials(baseRaw: unknown, fields: string[]): Rec {
  const base = asRec(baseRaw);
  const baseSchema = asRec(base.schema);
  const baseProps = asRec(baseSchema.properties);
  const properties: Rec = {};
  for (const f of fields) properties[f] = baseProps[f] ?? { type: "string" };
  return { ...base, schema: { ...baseSchema, type: "object", required: fields, properties } };
}

/**
 * Patch the form-owned fields onto the EXISTING raw auth so fields the editor
 * doesn't surface (`connect`, `identity_claims`, `resource`, `userinfo_endpoint`,
 * `token_endpoint_auth_method`, `_meta`, `delivery.env`/`delivery.files`, …)
 * survive an auths-tab edit. Without this merge, editing one field would clobber
 * the rest of an imported manifest's auth block.
 */
function patchAuth(base: Rec, a: AuthState): Rec {
  const out: Rec = { ...base, type: a.type };

  // authorized_uris / allow_all_uris are mutually exclusive.
  if (a.allowAllUris) {
    out.allow_all_uris = true;
    delete out.authorized_uris;
  } else {
    out.authorized_uris = a.authorizedUris;
    delete out.allow_all_uris;
  }

  // delivery.http — preserve sibling delivery.env / delivery.files.
  const delivery = asRec(base.delivery);
  if (a.deliveryHeaderName.trim()) {
    const http: Rec = { ...asRec(delivery.http), in: "header", name: a.deliveryHeaderName };
    if (a.deliveryHeaderPrefix) http.prefix = a.deliveryHeaderPrefix;
    else delete http.prefix;
    if (a.deliveryHeaderValue) http.value = a.deliveryHeaderValue;
    else delete http.value;
    out.delivery = { ...delivery, http };
  } else {
    const { http: _dropped, ...rest } = delivery;
    if (Object.keys(rest).length > 0) out.delivery = rest;
    else delete out.delivery;
  }

  if (a.type === "oauth2") {
    if (a.authorizationEndpoint) out.authorization_endpoint = a.authorizationEndpoint;
    else delete out.authorization_endpoint;
    if (a.tokenEndpoint) out.token_endpoint = a.tokenEndpoint;
    else delete out.token_endpoint;
    if (a.defaultScopes.length > 0) out.default_scopes = a.defaultScopes;
    else delete out.default_scopes;
    if (a.scopeCatalog.length > 0)
      out.scope_catalog = mergeScopeCatalog(base.scope_catalog, a.scopeCatalog);
    else delete out.scope_catalog;
    delete out.credentials;
  } else {
    if (a.credentialFields.length > 0)
      out.credentials = mergeCredentials(base.credentials, a.credentialFields);
    else delete out.credentials;
    delete out.authorization_endpoint;
    delete out.token_endpoint;
    delete out.default_scopes;
    delete out.scope_catalog;
  }

  return out;
}

export function setAuths(manifest: Rec, list: AuthState[]): Rec {
  const existing = asRec(manifest.auths);
  const auths: Rec = {};
  for (const a of list) {
    if (!a.key.trim()) continue;
    auths[a.key] = patchAuth(asRec(existing[a.key]), a);
  }
  return { ...manifest, auths };
}

export function emptyAuth(key: string): AuthState {
  return {
    key,
    type: "api_key",
    authorizedUris: [],
    allowAllUris: false,
    deliveryHeaderName: "Authorization",
    deliveryHeaderPrefix: "Bearer ",
    deliveryHeaderValue: "{$credential.api_key}",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    defaultScopes: [],
    scopeCatalog: [],
    credentialFields: ["api_key"],
  };
}

// ─── Tools policy ───────────────────────────────────────────

export interface ToolPolicyState {
  name: string;
  requiredAuthKey: string;
  requiredScopes: string[];
  urlPatterns: string[];
}

export function getToolsPolicy(manifest: Rec): ToolPolicyState[] {
  const tp = asRec(manifest.tools_policy);
  return Object.entries(tp).map(([name, raw]) => {
    const entry = asRec(raw);
    return {
      name,
      requiredAuthKey: typeof entry.required_auth_key === "string" ? entry.required_auth_key : "",
      requiredScopes: asStringArray(entry.required_scopes),
      urlPatterns: Array.isArray(entry.url_patterns)
        ? entry.url_patterns
            .map((p) => (typeof p === "string" ? p : asRec(p).pattern))
            .filter((p): p is string => typeof p === "string")
        : [],
    };
  });
}

/** Preserve per-pattern `methods` (+ other fields) by merging the form's
 * pattern strings onto matching base entries by `pattern`. */
function mergeUrlPatterns(baseRaw: unknown, patterns: string[]): Rec[] {
  const baseArr = Array.isArray(baseRaw) ? baseRaw : [];
  const byPattern = new Map<string, Rec>();
  for (const p of baseArr) {
    const r = asRec(p);
    if (typeof r.pattern === "string") byPattern.set(r.pattern, r);
  }
  // AFPS §7.x — url_patterns items are objects `{ pattern, methods? }`.
  return patterns.map((pattern) => ({ ...(byPattern.get(pattern) ?? {}), pattern }));
}

export function setToolsPolicy(manifest: Rec, list: ToolPolicyState[]): Rec {
  const next = { ...manifest };
  if (list.length === 0) {
    delete next.tools_policy;
    return next;
  }
  const existing = asRec(manifest.tools_policy);
  const tp: Rec = {};
  for (const t of list) {
    if (!t.name.trim()) continue;
    const entry: Rec = { ...asRec(existing[t.name]) };
    if (t.requiredAuthKey) entry.required_auth_key = t.requiredAuthKey;
    else delete entry.required_auth_key;
    if (t.requiredScopes.length > 0) entry.required_scopes = t.requiredScopes;
    else delete entry.required_scopes;
    if (t.urlPatterns.length > 0)
      entry.url_patterns = mergeUrlPatterns(entry.url_patterns, t.urlPatterns);
    else delete entry.url_patterns;
    tp[t.name] = entry;
  }
  next.tools_policy = tp;
  return next;
}
