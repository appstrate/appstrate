// SPDX-License-Identifier: Apache-2.0

import type { ResourceEntry } from "./types";
import type { EditorState } from "../../hooks/use-editor-state";
import type { MetadataState } from "./metadata-section";
import type { SchemaField } from "./schema-section";
import {
  getOrderedKeys,
  isFileField,
  isMultipleFileField,
  type JSONSchemaObject,
  type JSONSchema7,
  type JSONSchema7TypeName,
  type FileConstraint,
  type UIHint,
  type SchemaWrapper,
} from "@appstrate/core/form";
import {
  AFPS_SCHEMA_URLS,
  AFPS_SCHEMA_VERSION,
  dropRetiredRuntimeTools,
} from "@appstrate/core/validation";
import { isSelectableRuntimeTool } from "@appstrate/core/runtime-tools-catalog";
import {
  dropRetiredDependencyKeys,
  parseManifestIntegrations,
  writeManifestIntegrations,
} from "@appstrate/core/dependencies";

// ─── Version ranges ─────────────────────────────────────────

/**
 * Range form stored in agent manifests. Mirrors `npm install foo` (no
 * `--save-exact`), which writes `^X.Y.Z` — auto-receive non-breaking
 * fixes within the current major, opt-in major bumps. For exact pinning,
 * the user can hand-edit the raw manifest; the backend resolver
 * (`resolveVersionFromCatalog`) accepts every semver range form.
 */
export function caretRange(version: string): string {
  return `^${version}`;
}

// ─── Default state ──────────────────────────────────────────

export function defaultEditorState(orgSlug?: string, userEmail?: string): EditorState {
  return {
    manifest: {
      $schema: AFPS_SCHEMA_URLS.agent,
      schema_version: AFPS_SCHEMA_VERSION,
      type: "agent",
      name: orgSlug ? `@${orgSlug}/` : "",
      version: "1.0.0",
      display_name: "",
      description: "",
      author: userEmail ?? "",
      timeout: 300,
      dependencies: {},
    },
    operations: [{ op: "write", path: "prompt.md", text: "" }],
  };
}

// ─── Default manifests for skill/tool ───────────────────────

export function defaultSkillManifest(
  orgSlug?: string,
  userEmail?: string,
): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.skill,
    schema_version: AFPS_SCHEMA_VERSION,
    type: "skill",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    display_name: "",
    description: "",
    author: userEmail ?? "",
  };
}

/** Deliberately not yet valid: a new skill has no package id to prefill `name` from. */
export const DEFAULT_SKILL_CONTENT = "---\nname: \ndescription: \n---\n\n";

// ─── Default manifest for integration ───────────────────────

/**
 * Minimal valid AFPS integration skeleton for the "new" editor. Uses a
 * `remote` Streamable-HTTP source (no mcp-server bundle dependency, authorable
 * end-to-end via the editor) + a single api_key auth that injects the key as a
 * Bearer header. The author edits the URL, auth, and tools from here — the raw
 * JSON tab exposes the full manifest for the fields the structured form doesn't
 * cover yet.
 */
export function defaultIntegrationManifest(
  orgSlug?: string,
  userEmail?: string,
): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.integration,
    schema_version: AFPS_SCHEMA_VERSION,
    type: "integration",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    display_name: "",
    description: "",
    author: userEmail ?? "",
    source: {
      kind: "remote",
      remote: { url: "https://", transport: "streamable-http" },
    },
    auths: {
      primary: {
        type: "api_key",
        authorized_uris: [],
        credentials: {
          schema: {
            type: "object",
            required: ["api_key"],
            properties: {
              api_key: { type: "string", description: "API key for this integration." },
            },
          },
        },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
          },
        },
      },
    },
  };
}

// ─── Runtime tools (manifest.runtime_tools) ──────────────────

/**
 * Read the agent manifest's top-level `runtime_tools: string[]` (AFPS) —
 * the built-in runtime tools the agent author opted into (all opt-in,
 * `output` included). Tolerates a missing or malformed field by returning an
 * empty array. Ids the platform no longer offers (a retired tool such as the
 * removed `report`, or a hand-typed mistake in the raw-JSON tab) are dropped
 * so they can never render as a phantom checkbox nor block a later save.
 */
export function getRuntimeTools(m: Record<string, unknown>): string[] {
  const raw = m.runtime_tools;
  return Array.isArray(raw) ? raw.filter(isSelectableRuntimeTool) : [];
}

/**
 * Return the manifest with every piece of vocabulary the platform retired
 * removed, applied ONCE when an existing agent is loaded into the editor:
 *
 *   - `runtime_tools` reduced to the ids the platform still offers, so a
 *     retired id persisted long ago (e.g. `report`) silently disappears on the
 *     next save instead of round-tripping forever;
 *   - the retired AFPS 1.x `dependencies` keys (`tools` → `mcp_servers`,
 *     `providers` → `integrations`) dropped, for the same reason — a draft can
 *     acquire one by importing a bundle assembled from a legacy published
 *     version, and the author-direction save rejects it (#1021).
 *
 * In both cases the user would otherwise be shown an error for a field the
 * editor cannot even display, with no way to clear it. Typing either into the
 * raw-JSON tab still surfaces the rejection — this normalises on LOAD only.
 *
 * Both halves delegate to `@appstrate/core` — `dropRetiredRuntimeTools` is the
 * SAME function the publish path runs (`services/package-versions.ts`). The
 * editor used to reimplement it and the two drifted on the empty case, so an
 * agent whose only tool was retired serialised differently depending on which
 * path saved it. One implementation, one byte sequence. Core is type-gated
 * (`type: "agent"`), which is exactly this call site: `package-editor.tsx`
 * invokes it only in the agent branch.
 *
 * One function rather than a chain the call site composes, so a future
 * retirement is added here and cannot be forgotten at the call site.
 *
 * Returns the same reference when there is nothing to drop.
 */
export function withNormalizedManifest(m: Record<string, unknown>): Record<string, unknown> {
  return dropRetiredDependencyKeys(dropRetiredRuntimeTools(m).manifest);
}

/**
 * Write the selected runtime tool ids back into the manifest. An empty
 * selection drops the field entirely so the manifest stays minimal — the same
 * empty-case convention `dropRetiredRuntimeTools` follows, so a manifest is
 * byte-identical whichever of the two last touched it. Neither writer ever
 * mints `runtime_tools: []`; core deliberately preserves that spelling when an
 * author supplied it, but no platform path produces it.
 */
export function setRuntimeTools(m: Record<string, unknown>, tools: string[]): void {
  if (tools.length > 0) {
    m.runtime_tools = tools;
  } else {
    delete m.runtime_tools;
  }
}

// ─── Manifest accessors ─────────────────────────────────────

export function getManifestName(m: Record<string, unknown>): { scope: string; id: string } {
  const raw = (m.name as string) || "";
  const match = raw.match(/^@([^/]+)\/(.*)$/);
  return match ? { scope: match[1]!, id: match[2]! } : { scope: "", id: raw };
}

/** Extract MetadataState from a manifest object — the fields common to every
 * package type. Editor-specific manifest fields (e.g. the agent `timeout`)
 * are bound directly to manifest state by their editor and rendered through
 * MetadataSection's children slot.
 *
 * `author` accepts both the AFPS §3.1 bare-string form and the structured
 * `{ name, email?, url? }` object form: the editor's metadata UI is a single
 * text input, so the object form is rendered as its `name` field. Saving
 * collapses the object to a string — round-tripping the object shape
 * end-to-end would require an editor UI change.
 */
export function manifestToMetadata(m: Record<string, unknown>): MetadataState {
  const { scope, id } = getManifestName(m);
  const authorRaw = m.author;
  const authorText =
    typeof authorRaw === "string"
      ? authorRaw
      : authorRaw && typeof authorRaw === "object" && "name" in authorRaw
        ? ((authorRaw as { name?: string }).name ?? "")
        : "";
  return {
    id,
    scope,
    version: (m.version as string) ?? "1.0.0",
    displayName: (m.display_name as string) ?? "", // canonical-casing-exempt: MetadataState TS-internal field (CASING_CONVENTIONS.md carve-out); manifest write is via metadataToManifestPatch's snake_case `display_name`.
    description: (m.description as string) ?? "",
    author: authorText,
    keywords: Array.isArray(m.keywords) ? (m.keywords as string[]) : [],
  };
}

/** Apply MetadataState changes back into a manifest patch.
 *
 * Emits canonical AFPS snake_case (`display_name`).
 */
export function metadataToManifestPatch(m: MetadataState): Record<string, unknown> {
  return {
    name: m.scope ? `@${m.scope}/${m.id}` : m.id,
    version: m.version,
    display_name: m.displayName,
    description: m.description,
    author: m.author,
    keywords: m.keywords,
  };
}

function getDeps(m: Record<string, unknown>): Record<string, unknown> {
  return (m.dependencies ?? {}) as Record<string, unknown>;
}

export function getResourceEntries(
  m: Record<string, unknown>,
  type: "skills" | "integrations",
): ResourceEntry[] {
  // Integrations: version from `dependencies.integrations` (§4.1), selection from
  // `integrations_configuration` (§4.4); entries pass through whole, so no key is lost on save.
  if (type === "integrations") return parseManifestIntegrations(m);
  const deps = getDeps(m);
  const record = (deps[type] ?? {}) as Record<string, string>;
  return Object.entries(record).map(([id, version]) => ({ id, version }));
}

export function setResourceEntries(
  m: Record<string, unknown>,
  type: "skills" | "integrations",
  entries: ResourceEntry[],
): void {
  if (!m.dependencies) m.dependencies = {};
  const deps = m.dependencies as Record<string, unknown>;
  if (type === "integrations") {
    writeManifestIntegrations(
      m,
      entries.map((e) => ({ ...e, version: e.version ?? "*" })),
    );
    return;
  }
  const record: Record<string, string> = {};
  for (const e of entries) {
    if (e.id) record[e.id] = e.version ?? "*";
  }
  if (Object.keys(record).length > 0) {
    deps[type] = record;
  } else {
    delete deps[type];
  }
}

// ─── Resource entry helper ──────────────────────────────────

export function toResourceEntry(r: {
  id: string;
  version?: string;
  name?: string;
  description?: string;
}): ResourceEntry {
  return { id: r.id, version: r.version ?? "*", name: r.name, description: r.description };
}

// ─── Manifest → SchemaFields (used by AgentEditorInner) ─────

type ManifestSchemaWrapper = {
  schema?: JSONSchemaObject;
  file_constraints?: Record<string, FileConstraint>;
  ui_hints?: Record<string, UIHint>;
  property_order?: string[];
};

/** Narrow `manifest[key]` (`input` | `output`) to its schema wrapper. */
export function manifestSchemaWrapper(
  manifest: Record<string, unknown>,
  key: "input" | "output",
): ManifestSchemaWrapper | undefined {
  const raw = manifest[key] as ManifestSchemaWrapper | undefined;
  if (!raw) return undefined;
  return {
    schema: raw.schema,
    file_constraints: raw.file_constraints,
    ui_hints: raw.ui_hints,
    property_order: raw.property_order,
  };
}

/** Convert the manifest input/output wrappers into SchemaField arrays for the form. */
export function manifestToSchemaFields(
  manifest: Record<string, unknown>,
): Record<string, SchemaField[]> {
  const input = manifestSchemaWrapper(manifest, "input");
  const output = manifestSchemaWrapper(manifest, "output");
  return {
    input: schemaToFields(input?.schema, "input", input),
    output: schemaToFields(output?.schema, "output", output),
  };
}

// ─── Schema fields (used by SchemaSection) ──────────────────
//
// A field IS its JSON-Schema property (`SchemaField.prop`): every keyword lives
// there and nowhere else, so loading and saving a schema is lossless by
// construction. Only AFPS wrapper data (file constraints, placeholder) is kept
// beside it. Edits are the pure, immutable keyword operations below.

type Scalar = string | number | boolean;

export type FileKind = "none" | "single" | "multiple";

/** A keyword value as shown in a text input; `locked` = it cannot be edited as text (shown as JSON). */
export interface TextValue {
  text: string;
  locked: boolean;
}

const fileItem = (): JSONSchema7 => ({
  type: "string",
  format: "uri",
  contentMediaType: "application/octet-stream",
});

function itemsOf(prop: JSONSchema7): JSONSchema7 | undefined {
  return prop.items && typeof prop.items === "object" && !Array.isArray(prop.items)
    ? prop.items
    : undefined;
}

/** Editor type of a property: the `type`, or the first non-"null" entry of a type array. */
function primaryType(prop: JSONSchema7): string {
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== "null") : prop.type;
  return t ?? "string";
}

/** Type of the array's `items` (what its enum values are typed as). */
export function itemType(prop: JSONSchema7): string {
  const items = itemsOf(prop);
  return items ? primaryType(items) : "string";
}

export function fileKind(prop: JSONSchema7, mode: "input" | "output"): FileKind {
  if (mode !== "input" || !isFileField(prop)) return "none";
  return isMultipleFileField(prop) ? "multiple" : "single";
}

/** Type shown by the editor: file fields are strings (the file toggle carries the rest). */
export function fieldType(prop: JSONSchema7, mode: "input" | "output"): string {
  return fileKind(prop, mode) === "none" ? primaryType(prop) : "string";
}

/** Types whose `default`/`enum` values can be typed as text. */
export function isTextType(type: string): boolean {
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

// ─── Keyword operations ─────────────────────────────────────

/** Copy of `prop` with one keyword set, or removed when `value` is undefined. */
export function setKeyword<K extends keyof JSONSchema7>(
  prop: JSONSchema7,
  key: K,
  value: JSONSchema7[K] | undefined,
): JSONSchema7 {
  const next = { ...prop };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const ANNOTATIONS = ["description", "title", "$comment", "deprecated", "readOnly", "writeOnly"];

/** A fresh shape keeping only the type-agnostic annotations (not default/enum/examples/const). */
function freshShape(prop: JSONSchema7, shape: JSONSchema7): JSONSchema7 {
  const kept = Object.entries(prop).filter(([k]) => ANNOTATIONS.includes(k) || k.startsWith("x-"));
  return { ...shape, ...Object.fromEntries(kept) };
}

/** A fresh property of another type: keywords of the old type would be invalid. */
export function changeType(prop: JSONSchema7, type: JSONSchema7TypeName): JSONSchema7 {
  return freshShape(prop, { type });
}

/** Turn the file shape on/off. Always a fresh property. */
export function setFileKind(prop: JSONSchema7, kind: FileKind): JSONSchema7 {
  const shape: JSONSchema7 =
    kind === "none"
      ? { type: "string" }
      : kind === "single"
        ? fileItem()
        : { type: "array", items: fileItem() };
  return freshShape(prop, shape);
}

/** Set (or clear, when empty) `items.enum`, keeping the other `items` keywords and its type. */
export function setItemsEnum(prop: JSONSchema7, values: Scalar[]): JSONSchema7 {
  if (prop.items !== undefined && !itemsOf(prop)) return prop; // tuple/boolean items: not ours to rewrite
  const items = itemsOf(prop);
  if (values.length > 0) {
    return setKeyword(prop, "items", { ...(items ? items : { type: "string" }), enum: values });
  }
  if (!items) return prop;
  const { enum: _removed, ...rest } = items;
  return setKeyword(prop, "items", Object.keys(rest).length > 0 ? rest : undefined);
}

/** Numeric constraint input → number, or undefined (keyword removed) when empty or not a number. */
export function toNumber(text: string): number | undefined {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Text adapters (default, enum, items.enum) ──────────────

const NON_NEGATIVE_INTEGER = ["minLength", "maxLength", "maxItems"];

/** Numeric keyword input → number; undefined (keyword removed) when empty or invalid for that keyword. */
export function toKeywordNumber(keyword: string, text: string): number | undefined {
  const n = toNumber(text);
  if (n === undefined) return undefined;
  if (NON_NEGATIVE_INTEGER.includes(keyword)) return Number.isInteger(n) && n >= 0 ? n : undefined;
  if (keyword === "multipleOf") return n > 0 ? n : undefined;
  return n;
}

/** Text → typed value for `type`; undefined when empty or not a valid number. */
export function textToValue(text: string, type: string): Scalar | undefined {
  if (type === "string") return text || undefined;
  if (!text.trim()) return undefined;
  if (type === "number" || type === "integer") {
    const n = toNumber(text);
    return n !== undefined && type === "integer" ? Math.round(n) : n;
  }
  if (type === "boolean") {
    const word = text.trim();
    return word === "true" ? true : word === "false" ? false : undefined;
  }
  return text;
}

/** Comma-separated text → typed values (items trimmed, empty ones dropped). */
export function textToList(text: string, type: string): Scalar[] {
  const out: Scalar[] = [];
  for (const raw of text.split(",")) {
    const v = textToValue(raw.trim(), type);
    if (v !== undefined) out.push(v);
  }
  return out;
}

const locked = (value: unknown): TextValue => ({ text: JSON.stringify(value), locked: true });

/** Editable as text only if reading the text back yields the exact same value. */
export function valueToText(value: unknown, type: string): TextValue {
  if (value === undefined) return { text: "", locked: false };
  const scalar =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  if (!scalar || !isTextType(type)) return locked(value);
  const text = String(value);
  return text !== "" && textToValue(text, type) === value ? { text, locked: false } : locked(value);
}

/** List variant: every item must round-trip and survive the comma split untouched. */
export function listToText(value: unknown, type: string): TextValue {
  if (value === undefined) return { text: "", locked: false };
  const texts =
    Array.isArray(value) && value.length > 0 ? value.map((v) => valueToText(v, type)) : [];
  const editable =
    texts.length > 0 &&
    texts.every((t) => !t.locked && t.text === t.text.trim() && !t.text.includes(","));
  return editable ? { text: texts.map((t) => t.text).join(", "), locked: false } : locked(value);
}

/** `items.enum` as text; locked JSON of `items` when they are a tuple/boolean we cannot edit. */
export function itemsEnumText(prop: JSONSchema7): TextValue {
  if (prop.items !== undefined && !itemsOf(prop)) return locked(prop.items);
  return listToText(itemsOf(prop)?.enum, itemType(prop));
}

// ─── Manifest wrapper ⇄ fields ──────────────────────────────

export function schemaToFields(
  schema: JSONSchemaObject | undefined,
  mode: "input" | "output",
  wrapper?: {
    file_constraints?: Record<string, FileConstraint>;
    ui_hints?: Record<string, UIHint>;
    property_order?: string[];
  },
): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredSet = new Set(schema.required || []);
  return getOrderedKeys(schema, wrapper?.property_order).map((key) => {
    const prop = schema.properties[key]!;
    const base = { _id: crypto.randomUUID(), key, required: requiredSet.has(key), prop };
    if (mode !== "input") return base;
    if (isFileField(prop)) {
      const constraint = wrapper?.file_constraints?.[key];
      return {
        ...base,
        ...(constraint?.accept ? { accept: constraint.accept } : {}),
        ...(constraint?.max_size != null ? { maxSize: constraint.max_size } : {}), // canonical-casing-exempt: SchemaField TS-internal field (carve-out); manifest write is via fieldsToSchema's snake_case `max_size`.
      };
    }
    const placeholder = wrapper?.ui_hints?.[key]?.placeholder;
    return placeholder ? { ...base, placeholder } : base;
  });
}

/**
 * Build a fresh AFPS canonical `SchemaWrapper` from editor field state.
 *
 * Emits only canonical snake_case keys (`schema`, `file_constraints`,
 * `ui_hints`, `property_order`). The caller replaces the wrapper wholesale
 * (`updateManifest({ input: wrapper })`), which drops any non-canonical
 * camelCase keys carried by the previous wrapper value.
 */
export function fieldsToSchema(
  fields: SchemaField[],
  mode: "input" | "output",
  /** Current root schema: its keys other than `properties`/`required` (`$defs`, `title`, …) are kept. */
  base?: JSONSchemaObject,
): SchemaWrapper | null {
  const filtered = fields.filter((f) => f.key.trim());
  if (filtered.length === 0) return null;
  const properties: Record<string, JSONSchema7> = {};
  const required: string[] = [];
  const file_constraints: Record<string, FileConstraint> = {};
  const ui_hints: Record<string, UIHint> = {};
  for (const f of filtered) {
    const key = f.key.trim();
    properties[key] = f.prop;
    if (f.required) required.push(key);
    if (mode !== "input") continue;
    if (isFileField(f.prop)) {
      const constraint: FileConstraint = {};
      if (f.accept) constraint.accept = f.accept;
      if (f.maxSize !== undefined) constraint.max_size = f.maxSize;
      if (Object.keys(constraint).length > 0) file_constraints[key] = constraint;
    } else if (f.placeholder) {
      ui_hints[key] = { placeholder: f.placeholder };
    }
  }
  const rootSchema: JSONSchemaObject = { ...base, type: "object", properties };
  if (required.length > 0) rootSchema.required = required;
  else delete rootSchema.required;
  return {
    schema: rootSchema,
    ...(Object.keys(file_constraints).length > 0 ? { file_constraints } : {}),
    ...(Object.keys(ui_hints).length > 0 ? { ui_hints } : {}),
    property_order: filtered.map((f) => f.key.trim()),
  };
}
