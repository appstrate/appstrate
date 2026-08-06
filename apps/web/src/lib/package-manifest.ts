// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest → view-model readers for the read-only manifest overview.
 *
 * A manifest is jsonb the platform stores verbatim: `unknown` at runtime and
 * AUTHOR-CONTROLLED, exactly like the package bytes the file explorer shows.
 * Every reader here narrows defensively and DROPS what it does not recognise,
 * so a hand-written manifest can never make the view render `[object Object]`,
 * an empty row, or — the one that matters — a `javascript:` href.
 *
 * The readers live here rather than in the components because that is what
 * makes the rules testable without a DOM: presence, ordering, URL safety and
 * the `tools_policy` flattening are pure functions of the manifest.
 */

/** Any jsonb object. The manifest and every nested object share this shape. */
export type ManifestObject = Record<string, unknown>;

// ─── Narrowing primitives ───────────────────────────────────────────

/** A non-blank string, or `undefined` — a blank value is an absent field. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function obj(value: unknown): ManifestObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ManifestObject)
    : undefined;
}

/** `{ a: "1", b: "2" }` → `"a 1, b 2"`; anything else → `undefined`. */
function joinStringMap(value: unknown): string | undefined {
  const record = obj(value);
  if (!record) return undefined;
  const pairs = Object.entries(record)
    .map(([key, raw]) => {
      const val = str(raw);
      return val ? `${key} ${val}` : undefined;
    })
    .filter((pair): pair is string => pair !== undefined);
  return pairs.length > 0 ? pairs.join(", ") : undefined;
}

/**
 * The value as an http(s) URL, or `undefined`.
 *
 * The manifest's `homepage` / `repository` / … are author-controlled strings
 * that end up in an `href`. `javascript:`, `data:` and `vbscript:` all parse
 * as valid URLs, so a protocol allowlist — not a parse check — is the rule.
 * Relative and non-URL values (`support@example.com`) also land here and are
 * rendered as plain text by the caller rather than dropped.
 */
export function safeHttpUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : undefined;
}

// ─── Shared metadata block ──────────────────────────────────────────

/** A `label: value` row. `labelKey` is an i18n key in the `agents` namespace. */
export interface ManifestFact {
  labelKey: string;
  value: string;
}

/** A metadata row whose value is a URL when the manifest declared a safe one. */
export interface ManifestLink extends ManifestFact {
  /** Set only when `value` is an http(s) URL — see `safeHttpUrl`. */
  href?: string;
}

export interface ManifestDependencyGroup {
  labelKey: string;
  entries: Array<{ id: string; range: string }>;
}

export interface ManifestOverview {
  longDescription?: string;
  keywords: string[];
  /** license → author → schema_version → compatibility, in that order. */
  facts: ManifestFact[];
  links: ManifestLink[];
  dependencies: ManifestDependencyGroup[];
  /** True when the manifest declares none of the above. */
  isEmpty: boolean;
}

/** `"Ada"` or `{ name, email }` → one display string. */
function readAuthor(value: unknown): string | undefined {
  const plain = str(value);
  if (plain) return plain;
  const record = obj(value);
  const name = str(record?.name);
  if (!name) return undefined;
  const email = str(record?.email);
  return email ? `${name} <${email}>` : name;
}

/** `"https://…"` or `{ type, url }` → the URL string. */
function readRepository(value: unknown): string | undefined {
  return str(value) ?? str(obj(value)?.url);
}

function link(labelKey: string, value: string | undefined): ManifestLink | undefined {
  if (!value) return undefined;
  const href = safeHttpUrl(value);
  return href ? { labelKey, value, href } : { labelKey, value };
}

function fact(labelKey: string, value: string | undefined): ManifestFact | undefined {
  return value ? { labelKey, value } : undefined;
}

function present<T>(entries: Array<T | undefined>): T[] {
  return entries.filter((entry): entry is T => entry !== undefined);
}

function readDependencies(value: unknown): ManifestDependencyGroup[] {
  const deps = obj(value);
  if (!deps) return [];
  const groups: Array<[field: string, labelKey: string]> = [
    ["skills", "manifest.depSkills"],
    ["mcp_servers", "manifest.depMcpServers"],
    ["integrations", "manifest.depIntegrations"],
  ];
  return present(
    groups.map(([field, labelKey]) => {
      const entries = present(
        Object.entries(obj(deps[field]) ?? {}).map(([id, raw]) => {
          const range = str(raw);
          return range ? { id, range } : undefined;
        }),
      );
      return entries.length > 0 ? { labelKey, entries } : undefined;
    }),
  );
}

/**
 * The ~21 metadata fields every AFPS type shares.
 *
 * `name` / `type` / `display_name` / `description` / `version` are read by the
 * page header already, so re-rendering them here would be the same fact twice
 * on one screen. `icon` / `icons` / `screenshots` are references to images
 * inside the artifact: displaying author-controlled bytes as an image is the
 * sink the explorer's security scan exists to forbid, so they stay out.
 * `_meta` is an arbitrary extension bag with no renderable shape — it is
 * readable verbatim in the Package AFPS tab's `manifest.json`.
 */
export function readManifestOverview(manifest: unknown): ManifestOverview {
  const m = obj(manifest) ?? {};
  const compatibility = obj(m.compatibility);
  const platforms = strArray(compatibility?.platforms);

  const facts = present([
    fact("manifest.license", str(m.license)),
    fact("manifest.author", readAuthor(m.author)),
    fact("manifest.schemaVersion", str(m.schema_version)),
    fact("manifest.platforms", platforms.length > 0 ? platforms.join(", ") : undefined),
    fact("manifest.runtimes", joinStringMap(compatibility?.runtimes)),
    fact("manifest.clients", joinStringMap(compatibility?.clients)),
  ]);

  const links = present([
    link("manifest.repository", readRepository(m.repository)),
    link("manifest.homepage", str(m.homepage)),
    link("manifest.documentation", str(m.documentation)),
    link("manifest.support", str(m.support)),
    ...strArray(m.privacy_policies).map((policy) => link("manifest.privacyPolicy", policy)),
  ]);

  const longDescription = str(m.long_description);
  const keywords = strArray(m.keywords);
  const dependencies = readDependencies(m.dependencies);

  return {
    ...(longDescription ? { longDescription } : {}),
    keywords,
    facts,
    links,
    dependencies,
    isEmpty:
      !longDescription &&
      keywords.length === 0 &&
      facts.length === 0 &&
      links.length === 0 &&
      dependencies.length === 0,
  };
}

// ─── Integration tail ───────────────────────────────────────────────

export type IntegrationSourceView =
  | { kind: "local"; serverName: string; serverVersion: string; vendored: boolean }
  | { kind: "remote"; url: string; transport: string }
  | { kind: "none" };

export interface IntegrationAuthView {
  id: string;
  /** AFPS auth type verbatim (oauth2 | api_key | basic | mtls | custom). */
  type?: string;
  defaultScopes: string[];
}

/**
 * `source` + `auths` + the wildcard opt-in, and nothing else.
 *
 * `tools_policy` and `hidden_tools` are NOT read: the integration page's Tools
 * tab already renders the server-resolved catalog with its per-auth
 * `required_scopes` and the tool descriptions the manifest map lacks. A second,
 * poorer rendering of the same thing on the same page is not worth a reader.
 */
export interface IntegrationManifestDetails {
  source?: IntegrationSourceView;
  auths: IntegrationAuthView[];
  allowUndeclaredTools: boolean;
  isEmpty: boolean;
}

/** `source` is a oneOf — an incomplete branch is dropped, never half-rendered. */
export function readIntegrationSource(value: unknown): IntegrationSourceView | undefined {
  const source = obj(value);
  const kind = str(source?.kind);
  if (kind === "local") {
    const server = obj(source?.server);
    const serverName = str(server?.name);
    const serverVersion = str(server?.version);
    if (!serverName || !serverVersion) return undefined;
    return { kind: "local", serverName, serverVersion, vendored: server?.vendored === true };
  }
  if (kind === "remote") {
    const remote = obj(source?.remote);
    const url = str(remote?.url);
    const transport = str(remote?.transport);
    if (!url || !transport) return undefined;
    return { kind: "remote", url, transport };
  }
  if (kind === "none") return { kind: "none" };
  return undefined;
}

export function readIntegrationDetails(manifest: unknown): IntegrationManifestDetails {
  const m = obj(manifest) ?? {};
  const source = readIntegrationSource(m.source);
  const auths = Object.entries(obj(m.auths) ?? {}).map(([id, raw]) => {
    const auth = obj(raw);
    const type = str(auth?.type);
    return { id, ...(type ? { type } : {}), defaultScopes: strArray(auth?.default_scopes) };
  });
  const allowUndeclaredTools = m.allow_undeclared_tools === true;

  return {
    ...(source ? { source } : {}),
    auths,
    allowUndeclaredTools,
    isEmpty: !source && auths.length === 0 && !allowUndeclaredTools,
  };
}

// ─── MCP server tail ────────────────────────────────────────────────

export interface McpServerView {
  /** Runner runtime (node | python | binary | uv). */
  runtime?: string;
  entryPoint?: string;
  command?: string;
  args: string[];
}

export interface McpToolView {
  name: string;
  description?: string;
}

export interface McpUserConfigView {
  key: string;
  title?: string;
  description?: string;
  type?: string;
  required: boolean;
  sensitive: boolean;
}

export interface McpServerManifestDetails {
  manifestVersion?: string;
  server?: McpServerView;
  tools: McpToolView[];
  userConfig: McpUserConfigView[];
  isEmpty: boolean;
}

function readMcpServer(value: unknown): McpServerView | undefined {
  const server = obj(value);
  if (!server) return undefined;
  const config = obj(server.mcp_config);
  const view: McpServerView = {
    ...(str(server.type) ? { runtime: str(server.type) } : {}),
    ...(str(server.entry_point) ? { entryPoint: str(server.entry_point) } : {}),
    ...(str(config?.command) ? { command: str(config?.command) } : {}),
    args: strArray(config?.args),
  };
  const hasAnything =
    view.runtime !== undefined ||
    view.entryPoint !== undefined ||
    view.command !== undefined ||
    view.args.length > 0;
  return hasAnything ? view : undefined;
}

export function readMcpServerDetails(manifest: unknown): McpServerManifestDetails {
  const m = obj(manifest) ?? {};
  const manifestVersion = str(m.manifest_version);
  const server = readMcpServer(m.server);
  const tools = present(
    (Array.isArray(m.tools) ? m.tools : []).map((raw) => {
      const tool = obj(raw);
      const name = str(tool?.name);
      if (!name) return undefined;
      const description = str(tool?.description);
      return { name, ...(description ? { description } : {}) };
    }),
  );
  const userConfig = Object.entries(obj(m.user_config) ?? {}).map(([key, raw]) => {
    const entry = obj(raw);
    const title = str(entry?.title);
    const description = str(entry?.description);
    const type = str(entry?.type);
    return {
      key,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(type ? { type } : {}),
      required: entry?.required === true,
      sensitive: entry?.sensitive === true,
    };
  });

  return {
    ...(manifestVersion ? { manifestVersion } : {}),
    ...(server ? { server } : {}),
    tools,
    userConfig,
    isEmpty: !manifestVersion && !server && tools.length === 0 && userConfig.length === 0,
  };
}
