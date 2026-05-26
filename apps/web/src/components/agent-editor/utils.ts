// SPDX-License-Identifier: Apache-2.0

import type { AgentEditorState, ResourceEntry } from "./types";
import type { MetadataState } from "./metadata-section";
import type { SchemaField } from "./schema-section";
import {
  getOrderedKeys,
  isFileField,
  isMultipleFileField,
  type JSONSchemaObject,
  type JSONSchema7,
  type JSONSchema7TypeName,
  type JSONSchema7Type,
  type FileConstraint,
  type UIHint,
  type SchemaWrapper,
} from "@appstrate/core/form";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { parseManifestIntegrations, writeManifestIntegrations } from "@appstrate/core/dependencies";
import { AFPS_1X_READ_FALLBACK_REMOVAL } from "@appstrate/core/back-compat";

// Silence unused-warning — the import exists so removal of the back-compat
// reads below in `manifestToSchemaFields` is one `tsc` error away once the
// deprecation milestone ships.
void AFPS_1X_READ_FALLBACK_REMOVAL;

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

export function defaultEditorState(orgSlug?: string, userEmail?: string): AgentEditorState {
  return {
    manifest: {
      $schema: AFPS_SCHEMA_URLS.agent,
      schema_version: "2.0",
      type: "agent",
      name: orgSlug ? `@${orgSlug}/` : "",
      version: "1.0.0",
      display_name: "",
      description: "",
      author: userEmail ?? "",
      timeout: 300,
      dependencies: {},
    },
    prompt: "",
  };
}

// ─── Default manifests for skill/tool ───────────────────────

export function defaultSkillManifest(
  orgSlug?: string,
  userEmail?: string,
): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.skill,
    schema_version: "2.0",
    type: "skill",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    display_name: "",
    description: "",
    author: userEmail ?? "",
  };
}

export const DEFAULT_SKILL_CONTENT = "---\nname: \ndescription: \n---\n\n";

// ─── Runtime tools (manifest.runtime_tools) ──────────────────

/**
 * Read the agent manifest's top-level `runtime_tools: string[]` (AFPS 2.0;
 * was 1.x `runtimeTools`) — the built-in runtime tools the agent author opted
 * into (all opt-in, `output` included). Tolerates a missing or malformed field
 * by returning an empty array.
 *
 * Reads the canonical snake_case field first, then falls back to the legacy
 * 1.x camelCase `runtimeTools` for manifests saved before the 2.0 migration.
 * `setRuntimeTools` always writes the canonical form, so re-saving migrates
 * the manifest forward.
 */
export function getRuntimeTools(m: Record<string, unknown>): string[] {
  const raw = m.runtime_tools ?? m.runtimeTools;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Write the selected runtime tool ids back into the manifest. An empty
 * selection drops the field entirely so the manifest stays minimal.
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

/** Extract MetadataState from a manifest object. Includes timeout if present (agents only).
 *
 * Reads canonical AFPS 2.0 snake_case fields first; falls back to legacy 1.x
 * camelCase aliases (`displayName`, `runtimeTools`, etc.) so manifests saved
 * before the 2.0 migration still load into the editor. Writes go through
 * `metadataToManifestPatch`, which always emits canonical snake_case — so
 * editing-and-saving an old manifest migrates it forward.
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
    displayName: (m.display_name as string) ?? (m.displayName as string) ?? "",
    description: (m.description as string) ?? "",
    author: authorText,
    keywords: Array.isArray(m.keywords) ? (m.keywords as string[]) : [],
    ...(typeof m.timeout === "number" ? { timeout: m.timeout } : {}),
  };
}

/** Apply MetadataState changes back into a manifest patch. */
export function metadataToManifestPatch(m: MetadataState): Record<string, unknown> {
  return {
    name: m.scope ? `@${m.scope}/${m.id}` : m.id,
    version: m.version,
    display_name: m.displayName,
    description: m.description,
    author: m.author,
    keywords: m.keywords,
    ...(m.timeout !== undefined ? { timeout: m.timeout } : {}),
  };
}

export function getDeps(m: Record<string, unknown>): Record<string, unknown> {
  return (m.dependencies ?? {}) as Record<string, unknown>;
}

export function getResourceEntries(
  m: Record<string, unknown>,
  type: "skills" | "integrations",
): ResourceEntry[] {
  // Integrations: AFPS 2.0.2 §4.1 canonical inline object form —
  // `dependencies.integrations.<id>` is `{ version, scopes?, tools?, auth_key? }`.
  // `parseManifestIntegrations` merges canonical + the deprecated
  // `integrations_configuration` alias + a legacy top-level `integrations`
  // block (back-compat for manifests saved before AFPS 2.0.2).
  if (type === "integrations") {
    return parseManifestIntegrations(m).map((e) => ({
      id: e.id,
      version: e.version,
      ...(e.tools !== undefined ? { tools: [...e.tools] } : {}),
      ...(e.scopes !== undefined ? { scopes: [...e.scopes] } : {}),
    }));
  }
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
      entries
        .filter((e) => e.id)
        .map((e) => ({
          id: e.id,
          version: e.version ?? "*",
          ...(e.tools !== undefined ? { tools: [...e.tools] } : {}),
          ...(e.scopes !== undefined ? { scopes: [...e.scopes] } : {}),
        })),
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

/** Convert manifest input/output/config wrappers into SchemaField arrays for the form. */
export function manifestToSchemaFields(
  manifest: Record<string, unknown>,
): Record<string, SchemaField[]> {
  // AFPS 1.x compat: legacy camelCase wrappers (`fileConstraints` /
  // `uiHints` / `propertyOrder` / `maxSize`) are still on disk for
  // manifests saved before the 2.0 migration. Accept both shapes, prefer
  // canonical snake_case. `fieldsToSchema` always writes canonical so
  // re-saving migrates the manifest forward. Removal milestone:
  // AFPS_1X_READ_FALLBACK_REMOVAL (see @appstrate/core/back-compat). The
  // top-level `void` reference makes removal a tsc error.
  type LegacyConstraint = { accept?: string; max_size?: number; maxSize?: number };
  type ManifestWrapper = {
    schema?: JSONSchemaObject;
    file_constraints?: Record<string, LegacyConstraint>;
    fileConstraints?: Record<string, LegacyConstraint>;
    ui_hints?: Record<string, { placeholder?: string }>;
    uiHints?: Record<string, { placeholder?: string }>;
    property_order?: string[];
    propertyOrder?: string[];
  };
  const wrapperFor = (key: string) => {
    const raw = manifest[key] as ManifestWrapper | undefined;
    if (!raw) return undefined;
    const fileConstraintsRaw = raw.file_constraints ?? raw.fileConstraints;
    const fileConstraints = fileConstraintsRaw
      ? Object.fromEntries(
          Object.entries(fileConstraintsRaw).map(([k, v]) => [
            k,
            {
              ...(v.accept !== undefined ? { accept: v.accept } : {}),
              // Bridge legacy maxSize into canonical max_size before passing
              // to schemaToFields (which reads max_size via FileConstraint).
              ...(v.max_size != null
                ? { max_size: v.max_size }
                : v.maxSize != null
                  ? { max_size: v.maxSize }
                  : {}),
            } satisfies FileConstraint,
          ]),
        )
      : undefined;
    return {
      schema: raw.schema,
      file_constraints: fileConstraints,
      ui_hints: raw.ui_hints ?? raw.uiHints,
      property_order: raw.property_order ?? raw.propertyOrder,
    };
  };
  return {
    input: schemaToFields(wrapperFor("input")?.schema, "input", wrapperFor("input")),
    output: schemaToFields(wrapperFor("output")?.schema, "output", wrapperFor("output")),
    config: schemaToFields(wrapperFor("config")?.schema, "config", wrapperFor("config")),
  };
}

// ─── Schema field conversion (used by SchemaSection) ────────

function convertDefaultValue(value: string, type: string): unknown {
  if (!value) return undefined;
  if (type === "number" || type === "integer") {
    const n = Number(value);
    if (isNaN(n)) return value;
    return type === "integer" ? Math.round(n) : n;
  }
  if (type === "boolean") return value === "true";
  return value;
}

export function schemaToFields(
  schema: JSONSchemaObject | undefined,
  mode: "input" | "output" | "config" | "credentials",
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
    const type = isInputFile ? "string" : typeof prop.type === "string" ? prop.type : "string";

    // Extract array enum items
    let arrayEnumItems = "";
    if (
      type === "array" &&
      prop.items &&
      typeof prop.items === "object" &&
      !Array.isArray(prop.items)
    ) {
      const items = prop.items as JSONSchema7;
      if (Array.isArray(items.enum)) {
        arrayEnumItems = items.enum.join(", ");
      }
    }

    return {
      _id: crypto.randomUUID(),
      key,
      type,
      description: prop.description || "",
      required: requiredSet.has(key),
      ...(isInputFile
        ? {
            isFile: true,
            accept: constraints?.accept || "",
            maxSize: constraints?.max_size != null ? String(constraints.max_size) : "",
            multiple: isMultipleFileField(prop),
            maxFiles: prop.maxItems != null ? String(prop.maxItems) : "",
          }
        : {}),
      ...(mode === "input" && !fileField
        ? {
            placeholder: hint?.placeholder || "",
            default: prop.default != null ? String(prop.default) : "",
          }
        : {}),
      ...(mode === "config"
        ? {
            default: prop.default != null ? String(prop.default) : "",
            enumValues: Array.isArray(prop.enum) ? prop.enum.join(", ") : "",
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

export function fieldsToSchema(
  fields: SchemaField[],
  mode: "input" | "output" | "config" | "credentials",
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
      // Generate standard JSON Schema for file fields
      const fileItemProp: JSONSchema7 = {
        type: "string",
        format: "uri",
        contentMediaType: "application/octet-stream",
      };
      if (f.multiple) {
        const prop: JSONSchema7 = { type: "array", items: fileItemProp };
        if (f.description) prop.description = f.description;
        if (f.maxFiles) {
          const n = Number(f.maxFiles);
          if (!isNaN(n)) prop.maxItems = n;
        }
        properties[key] = prop;
      } else {
        const prop: JSONSchema7 = { ...fileItemProp };
        if (f.description) prop.description = f.description;
        properties[key] = prop;
      }
      // Build file_constraints (canonical AFPS 2.0 snake_case)
      const constraint: FileConstraint = {};
      if (f.accept) constraint.accept = f.accept;
      if (f.maxSize) {
        const n = Number(f.maxSize);
        if (!isNaN(n)) constraint.max_size = n;
      }
      if (Object.keys(constraint).length > 0) file_constraints[key] = constraint;
    } else {
      const prop: JSONSchema7 = { type: f.type as JSONSchema7TypeName };
      if (f.description) prop.description = f.description;
      if (mode === "input" || mode === "config") {
        const def = convertDefaultValue(f.default || "", f.type);
        if (def != null) prop.default = def as JSONSchema7Type;
      }
      if (mode === "config") {
        const enumVals = f.enumValues
          ?.split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (enumVals && enumVals.length > 0) prop.enum = enumVals;
      }
      // String format
      if (f.type === "string" && f.format && f.format !== "__none") {
        prop.format = f.format;
      }
      // String constraints
      if (f.type === "string") {
        if (f.minLength) {
          const n = Number(f.minLength);
          if (!isNaN(n)) prop.minLength = n;
        }
        if (f.maxLength) {
          const n = Number(f.maxLength);
          if (!isNaN(n)) prop.maxLength = n;
        }
        if (f.pattern) prop.pattern = f.pattern;
      }
      // Number/integer constraints
      if (f.type === "number" || f.type === "integer") {
        if (f.minimum) {
          const n = Number(f.minimum);
          if (!isNaN(n)) prop.minimum = n;
        }
        if (f.maximum) {
          const n = Number(f.maximum);
          if (!isNaN(n)) prop.maximum = n;
        }
        if (f.step) {
          const n = Number(f.step);
          if (!isNaN(n)) prop.multipleOf = n;
        }
      }
      // Array with enum items → multiselect schema
      if (f.type === "array" && f.arrayEnumItems) {
        const items = f.arrayEnumItems
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (items.length > 0) {
          prop.items = { type: "string", enum: items } as JSONSchema7;
        }
      }
      properties[key] = prop;
      // Build ui_hints for placeholder (canonical AFPS 2.0 snake_case)
      if (mode === "input" && f.placeholder) {
        ui_hints[key] = { placeholder: f.placeholder };
      }
    }
    if (f.required) required.push(key);
  }
  return {
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    ...(Object.keys(file_constraints).length > 0 ? { file_constraints } : {}),
    ...(Object.keys(ui_hints).length > 0 ? { ui_hints } : {}),
    property_order: filtered.map((f) => f.key.trim()),
  };
}
