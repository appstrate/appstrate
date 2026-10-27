// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest → view-model readers for the read-only overview. A manifest is AUTHOR-CONTROLLED jsonb,
 * so every reader narrows defensively and DROPS what it does not recognise: never `[object Object]`,
 * an empty row, or a `javascript:` href. Pure functions so the rules are testable without a DOM.
 */

import { normalizeHttpUrl } from "@appstrate/core/url";
import { effectiveMcpServerType, type McpServerManifest } from "@appstrate/core/mcp-server-meta";

/** Any jsonb object. The manifest and every nested object share this shape. */
type ManifestObject = Record<string, unknown>;

// ─── Narrowing primitives ───────────────────────────────────────────

/** A non-blank string, or `undefined` — a blank value is an absent field. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Non-blank strings VERBATIM, duplicates kept: `mcp_config.args` is an argv (`--with a --with b`), so renderers key by index. */
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

// ─── Shared metadata block ──────────────────────────────────────────

/** A `label: value` row. `labelKey` is an i18n key in the `agents` namespace. */
export interface ManifestFact {
  labelKey: string;
  value: string;
}

/** A metadata row whose value is a URL when the manifest declared a safe one. */
export interface ManifestLink extends ManifestFact {
  /** Set only when `value` is an http(s) URL — see `normalizeHttpUrl`. */
  href?: string;
}

interface ManifestDependencyGroup {
  labelKey: string;
  entries: Array<{ id: string; range: string }>;
}

interface ManifestOverview {
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

/**
 * A displayable row, linked only when the value is an http(s) URL. `javascript:`, `data:` and
 * `vbscript:` parse as valid URLs, so the rule is the protocol allowlist of `@appstrate/core/url`
 * (shared with the integration page), not a successful parse. A rejected value still renders as
 * plain text: dropping it would hide what an auditor needs.
 */
function link(labelKey: string, value: string | undefined): ManifestLink | undefined {
  if (!value) return undefined;
  const href = normalizeHttpUrl(value);
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
 * The metadata fields every AFPS type shares. Left out on purpose: the header's fields
 * (`name`/`type`/`display_name`/`description`/`version`); `icon`/`icons`/`screenshots`, because
 * displaying author-controlled bytes as an image is the sink the explorer's security scan forbids;
 * and `_meta`, an unrenderable extension bag readable in `manifest.json`.
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

// ─── Integration source ───────────────────────────────────────────────

type IntegrationSourceView =
  | { kind: "local"; serverName: string; serverVersion: string }
  | { kind: "remote"; url: string; transport: string }
  | { kind: "none" };

/** `source` is a oneOf — an incomplete branch is dropped, never half-rendered. */
export function readIntegrationSource(value: unknown): IntegrationSourceView | undefined {
  const source = obj(value);
  const kind = str(source?.kind);
  if (kind === "local") {
    const server = obj(source?.server);
    const serverName = str(server?.name);
    const serverVersion = str(server?.version);
    if (!serverName || !serverVersion) return undefined;
    return { kind: "local", serverName, serverVersion };
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

// ─── MCP server tail ────────────────────────────────────────────────

interface McpServerView {
  /** The runtime the PLATFORM would run this on: `_meta` override, else MCPB `server.type` ({@link readMcpServer}). */
  runtime?: string;
  entryPoint?: string;
  command?: string;
  args: string[];
}

interface McpToolView {
  name: string;
  description?: string;
}

interface McpUserConfigView {
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
}

/**
 * Takes the WHOLE manifest because the runtime is not a property of `server`: core's
 * `effectiveMcpServerType` (the function every spawn path calls) reads
 * `_meta["dev.appstrate/mcp-server"].runtime` at the ROOT, falling back to `server.type`. They
 * disagree by design: MCPB's enum has no `bun`, so a bun server keeps `server.type: "node"`.
 */
function readMcpServer(manifest: ManifestObject): McpServerView | undefined {
  const server = obj(manifest.server);
  if (!server) return undefined;
  const config = obj(server.mcp_config);
  // The override half narrows `_meta` itself; the `server.type` fallback is verbatim so a draft typo shows as written.
  const runtime = effectiveMcpServerType(manifest as unknown as McpServerManifest);
  const view: McpServerView = {
    ...(runtime ? { runtime } : {}),
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
  const server = readMcpServer(m);
  // `tools` is a raw jsonb array, so `name` may repeat and the view keys rows by name: first declaration wins.
  const seenTools = new Set<string>();
  const tools = present(
    (Array.isArray(m.tools) ? m.tools : []).map((raw) => {
      const tool = obj(raw);
      const name = str(tool?.name);
      if (!name || seenTools.has(name)) return undefined;
      seenTools.add(name);
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
  };
}
