// SPDX-License-Identifier: Apache-2.0

import type { ResourceEntry } from "./types";
import type { MetadataState } from "./metadata-section";
import type { SchemaField } from "./types";
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

/** Range stored in agent manifests, as `npm install foo` writes it. Exact pins are a raw-manifest edit. */
export function caretRange(version: string): string {
  return `^${version}`;
}

// ─── Default manifests ──────────────────────────────────────

export function defaultAgentManifest(
  orgSlug?: string,
  userEmail?: string,
): Record<string, unknown> {
  return {
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
  };
}

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

// ─── Default manifest for integration ───────────────────────

/** Minimal valid integration skeleton: a `remote` Streamable-HTTP source and one api_key auth sent as a Bearer header. */
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

/** The manifest's `runtime_tools`; tolerates a missing or malformed field and drops ids the platform no longer offers. */
export function getRuntimeTools(m: Record<string, unknown>): string[] {
  const raw = m.runtime_tools;
  return Array.isArray(raw) ? raw.filter(isSelectableRuntimeTool) : [];
}

/**
 * Strips retired vocabulary (retired `runtime_tools` ids, AFPS 1.x `dependencies` keys) once, when an
 * existing agent is loaded — otherwise the user sees an error for a field the editor cannot display.
 * Delegates to core, the same code the publish path runs, so both serialise identically; core is
 * agent-gated and `package-editor.tsx` calls this only in its agent branch.
 */
export function withNormalizedManifest(m: Record<string, unknown>): Record<string, unknown> {
  return dropRetiredDependencyKeys(dropRetiredRuntimeTools(m).manifest);
}

/** An empty selection drops the field (never mints `runtime_tools: []`), matching `dropRetiredRuntimeTools` so the manifest bytes are the same either way. */
export function setRuntimeTools(m: Record<string, unknown>, tools: string[]): void {
  if (tools.length > 0) {
    m.runtime_tools = tools;
  } else {
    delete m.runtime_tools;
  }
}

/** The server refuses an output schema without the `output` runtime tool; declaring a schema turns it on. */
export function withOutputTool(m: Record<string, unknown>): Record<string, unknown> {
  const tools = getRuntimeTools(m);
  if (tools.includes("output")) return m;
  const next = { ...m };
  setRuntimeTools(next, [...tools, "output"]);
  return next;
}

// ─── Manifest accessors ─────────────────────────────────────

export function getManifestName(m: Record<string, unknown>): { scope: string; id: string } {
  const raw = (m.name as string) || "";
  const match = raw.match(/^@([^/]+)\/(.*)$/);
  return match ? { scope: match[1]!, id: match[2]! } : { scope: "", id: raw };
}

/**
 * `author` accepts the bare-string and the `{ name, email?, url? }` forms (AFPS §3.1); the single
 * text input shows the object's `name`, and saving collapses it to a string.
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

/** Emits canonical AFPS snake_case (`display_name`). */
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
    if (!m.dependencies) m.dependencies = {};
    (m.dependencies as Record<string, unknown>)[type] = record;
  } else if (m.dependencies) {
    // An empty group writes nothing: a manifest that declares no
    // `dependencies` stays that way, so the editor does not read as dirty.
    delete (m.dependencies as Record<string, unknown>)[type];
  }
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
  return raw;
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

type FileKind = "none" | "single" | "multiple";

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

/** Numeric input → number, or undefined when empty or not a number. */
function parseNumber(text: string): number | undefined {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Text adapters (default, enum, items.enum) ──────────────

export type NumericKeyword =
  "minimum" | "maximum" | "multipleOf" | "minLength" | "maxLength" | "maxItems";

const NON_NEGATIVE_INTEGER: string[] = ["minLength", "maxLength", "maxItems", "maxSize"];

/** Numeric keyword (or file `maxSize`) input → number; undefined (removed) when empty or invalid for it. */
export function toKeywordNumber(
  keyword: NumericKeyword | "maxSize",
  text: string,
): number | undefined {
  const n = parseNumber(text);
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
    const n = parseNumber(text);
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

/** `list` with the item at `index` swapped with its neighbour; `list` itself when there is none. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

// ─── Manifest wrapper ⇄ fields ──────────────────────────────

function schemaToFields(
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

/** Emits only canonical snake_case keys; the caller replaces the wrapper wholesale, dropping non-canonical ones. */
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
