// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest → view-model readers for the read-only overview. A manifest is AUTHOR-CONTROLLED jsonb,
 * so every reader narrows defensively and DROPS what it does not recognise: never `[object Object]`,
 * an empty row, or a `javascript:` href. Pure functions so the rules are testable without a DOM.
 */

import { normalizeHttpUrl } from "@appstrate/core/url";

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

interface ManifestOverview {
  longDescription?: string;
  keywords: string[];
  /** license → author → schema_version → compatibility, in that order. */
  facts: ManifestFact[];
  links: ManifestLink[];
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

  return {
    ...(longDescription ? { longDescription } : {}),
    keywords,
    facts,
    links,
    isEmpty: !longDescription && keywords.length === 0 && facts.length === 0 && links.length === 0,
  };
}

// ─── Integration source ───────────────────────────────────────────────

type IntegrationSourceView =
  | { kind: "local"; serverType: string; entryPoint: string }
  | { kind: "remote"; url: string; transport: string }
  | { kind: "none" };

/** `source` is a oneOf — an incomplete branch is dropped, never half-rendered. */
export function readIntegrationSource(value: unknown): IntegrationSourceView | undefined {
  const source = obj(value);
  const kind = str(source?.kind);
  if (kind === "local") {
    const server = obj(source?.server);
    const serverType = str(server?.type);
    const entryPoint = str(server?.entry_point);
    if (!serverType || !entryPoint) return undefined;
    return { kind: "local", serverType, entryPoint };
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
