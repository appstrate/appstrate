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

// ─── Schema field conversion (used by SchemaSection) ────────

type Scalar = string | number | boolean;

function convertDefaultValue(value: string, type: string): Scalar | undefined {
  if (!value) return undefined;
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (isNaN(n)) return value;
    return type === "integer" ? Math.round(n) : n;
  }
  if (type === "boolean") return value === "true";
  return value;
}

/** Comma-separated text → typed values, converted per `type` like a default. */
function parseList(text: string | undefined, type: string): Scalar[] {
  const out: Scalar[] = [];
  for (const raw of (text ?? "").split(",")) {
    const v = convertDefaultValue(raw.trim(), type);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/**
 * A value can live in a text input only if reading the text back yields the
 * exact same value (no object, no "1.5" under integer, no comma inside a list
 * item). Anything else is kept untouched from the source schema.
 */
function isTextEditable(v: unknown, type: string, inList: boolean): boolean {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return false;
  const s = String(v);
  if (s === "" || (inList && (s !== s.trim() || s.includes(",")))) return false;
  return convertDefaultValue(s, type) === v;
}

function itemsOf(prop: JSONSchema7): JSONSchema7 | undefined {
  return prop.items && typeof prop.items === "object" && !Array.isArray(prop.items)
    ? prop.items
    : undefined;
}

/** Editor field type: the `type`, or the first non-"null" entry of a type array. */
function primaryType(prop: JSONSchema7): string {
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== "null") : prop.type;
  return t ?? "string";
}

function itemType(prop: JSONSchema7): string {
  const items = itemsOf(prop);
  return items ? primaryType(items) : "string";
}

type EditableKeyword = "default" | "enum" | "items.enum";

/** JSON of a keyword value the text inputs cannot represent losslessly (else undefined). */
function lockedValue(prop: JSONSchema7, type: string, kw: EditableKeyword): string | undefined {
  const value = kw === "default" ? prop.default : kw === "enum" ? prop.enum : itemsOf(prop)?.enum;
  if (value === undefined) return undefined;
  if (kw === "default")
    return isTextEditable(value, type, false) ? undefined : JSON.stringify(value);
  const itemsType = kw === "enum" ? type : itemType(prop);
  const editable = Array.isArray(value) && value.every((v) => isTextEditable(v, itemsType, true));
  return editable ? undefined : JSON.stringify(value);
}

/**
 * The original property to start from: only while the field still has the
 * shape it was loaded with. A type change or file toggle starts fresh, since
 * keywords of the old type would be invalid.
 */
function reusableSource(f: SchemaField, mode: "input" | "output"): JSONSchema7 | undefined {
  const s = f.source;
  if (!s || f.isFile) return undefined;
  if (mode === "input" && isFileField(s)) return undefined;
  return primaryType(s) === f.type ? s : undefined;
}

/** Same idea for file fields: reusable while still a file field of the same single/multiple kind. */
function reusableFileSource(f: SchemaField): JSONSchema7 | undefined {
  const s = f.source;
  return s && isFileField(s) && isMultipleFileField(s) === !!f.multiple ? s : undefined;
}

/** JSON shown read-only in place of a text input when the value cannot be edited as text. */
export function lockedKeyword(
  f: SchemaField,
  mode: "input" | "output",
  kw: EditableKeyword,
): string | undefined {
  const s = reusableSource(f, mode);
  return s && lockedValue(s, f.type, kw);
}

function assign<K extends keyof JSONSchema7>(
  prop: JSONSchema7,
  key: K,
  value: JSONSchema7[K] | undefined,
): void {
  if (value === undefined) delete prop[key];
  else prop[key] = value;
}

function numberOrUndefined(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(text);
  return isNaN(n) ? undefined : n;
}

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
  const keys = getOrderedKeys(schema, wrapper?.property_order);
  return keys.map((key) => {
    const prop = schema.properties[key]!;
    const fileField = isFileField(prop);
    const isInputFile = mode === "input" && fileField;
    const constraints = wrapper?.file_constraints?.[key];
    const hint = wrapper?.ui_hints?.[key];
    const type = isInputFile ? "string" : primaryType(prop);

    // Extract array enum items
    let arrayEnumItems = "";
    if (
      type === "array" &&
      prop.items &&
      typeof prop.items === "object" &&
      !Array.isArray(prop.items)
    ) {
      const items = prop.items;
      if (Array.isArray(items.enum) && !lockedValue(prop, type, "items.enum")) {
        arrayEnumItems = items.enum.join(", ");
      }
    }

    return {
      _id: crypto.randomUUID(),
      key,
      type,
      description: prop.description || "",
      required: requiredSet.has(key),
      source: prop,
      ...(isInputFile
        ? {
            isFile: true,
            accept: constraints?.accept || "",
            maxSize: constraints?.max_size != null ? String(constraints.max_size) : "", // canonical-casing-exempt: SchemaField TS-internal field (carve-out); manifest write is via fieldsToSchema's snake_case `max_size`.
            multiple: isMultipleFileField(prop),
            maxFiles: prop.maxItems != null ? String(prop.maxItems) : "",
          }
        : {}),
      ...(mode === "input" && !fileField
        ? {
            placeholder: hint?.placeholder || "",
            default:
              prop.default !== undefined && !lockedValue(prop, type, "default")
                ? String(prop.default)
                : "",
            enumValues:
              Array.isArray(prop.enum) && !lockedValue(prop, type, "enum")
                ? prop.enum.join(", ")
                : "",
          }
        : {}),
      // String format
      ...(type === "string" && prop.format ? { format: prop.format } : {}),
      // String constraints
      ...(type === "string" && prop.minLength != null ? { minLength: String(prop.minLength) } : {}),
      ...(type === "string" && prop.maxLength != null ? { maxLength: String(prop.maxLength) } : {}),
      ...(type === "string" && prop.pattern ? { pattern: prop.pattern } : {}),
      // Number/integer constraints
      ...((type === "number" || type === "integer") && prop.minimum != null
        ? { minimum: String(prop.minimum) }
        : {}),
      ...((type === "number" || type === "integer") && prop.maximum != null
        ? { maximum: String(prop.maximum) }
        : {}),
      ...((type === "number" || type === "integer") && prop.multipleOf != null
        ? { step: String(prop.multipleOf) }
        : {}),
      // Array enum items
      ...(arrayEnumItems ? { arrayEnumItems } : {}),
    };
  });
}

/**
 * Build a fresh AFPS canonical `SchemaWrapper` from editor field state.
 *
 * Emits only canonical snake_case keys (`schema`, `file_constraints`,
 * `ui_hints`, `property_order`). Every per-property entry is constructed
 * from scratch, so non-canonical camelCase siblings (`fileConstraints`,
 * `uiHints`, `propertyOrder`, per-property `maxSize`) cannot leak through.
 * The caller replaces the wrapper wholesale (`updateManifest({ input:
 * wrapper })`); the shallow-merge semantics drop any pre-existing camelCase
 * keys carried by the previous wrapper value. Idempotent against
 * already-canonical manifests.
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
    if (mode === "input" && f.isFile) {
      // Standard JSON Schema for file fields; start from the original when its shape is unchanged
      const fileItemProp: JSONSchema7 = {
        type: "string",
        format: "uri",
        contentMediaType: "application/octet-stream",
      };
      const fileSrc = reusableFileSource(f);
      const prop: JSONSchema7 = fileSrc
        ? { ...fileSrc }
        : f.multiple
          ? { type: "array", items: fileItemProp }
          : { ...fileItemProp };
      assign(prop, "description", f.description || undefined);
      if (f.multiple) assign(prop, "maxItems", numberOrUndefined(f.maxFiles));
      properties[key] = prop;
      // Build file_constraints (canonical AFPS snake_case)
      const constraint: FileConstraint = {};
      if (f.accept) constraint.accept = f.accept;
      if (f.maxSize) {
        const n = Number(f.maxSize);
        if (!isNaN(n)) constraint.max_size = n;
      }
      if (Object.keys(constraint).length > 0) file_constraints[key] = constraint;
    } else {
      const src = reusableSource(f, mode);
      // Start from the original so keywords the editor does not manage survive.
      const prop: JSONSchema7 = src ? { ...src } : { type: f.type as JSONSchema7TypeName };
      assign(prop, "description", f.description || undefined);
      if (mode === "input") {
        if (!lockedKeyword(f, mode, "default")) {
          assign(prop, "default", convertDefaultValue(f.default || "", f.type));
        }
        if (!lockedKeyword(f, mode, "enum")) {
          const enumVals = parseList(f.enumValues, f.type);
          assign(prop, "enum", enumVals.length > 0 ? enumVals : undefined);
        }
      }
      if (f.type === "string") {
        assign(prop, "format", f.format && f.format !== "__none" ? f.format : undefined);
        assign(prop, "minLength", numberOrUndefined(f.minLength));
        assign(prop, "maxLength", numberOrUndefined(f.maxLength));
        assign(prop, "pattern", f.pattern || undefined);
      }
      if (f.type === "number" || f.type === "integer") {
        assign(prop, "minimum", numberOrUndefined(f.minimum));
        assign(prop, "maximum", numberOrUndefined(f.maximum));
        assign(prop, "multipleOf", numberOrUndefined(f.step));
      }
      // Array with enum items → multiselect schema; other `items` stay as loaded.
      if (f.type === "array" && !lockedKeyword(f, mode, "items.enum")) {
        const srcItems = src && itemsOf(src);
        const type = srcItems ? itemType(src) : "string";
        const vals = parseList(f.arrayEnumItems, type);
        if (vals.length > 0) {
          prop.items = {
            ...(srcItems?.type === undefined ? { type: type as JSONSchema7TypeName } : {}),
            ...srcItems,
            enum: vals,
          };
        } else if (srcItems?.enum) {
          const { enum: _removed, ...rest } = srcItems;
          assign(prop, "items", Object.keys(rest).length > 0 ? rest : undefined);
        }
      }
      properties[key] = prop;
      // Build ui_hints for placeholder (canonical AFPS snake_case)
      if (mode === "input" && f.placeholder) {
        ui_hints[key] = { placeholder: f.placeholder };
      }
    }
    if (f.required) required.push(key);
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
