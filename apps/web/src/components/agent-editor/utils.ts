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
      schemaVersion: "1.1",
      type: "agent",
      name: orgSlug ? `@${orgSlug}/` : "",
      version: "1.0.0",
      displayName: "",
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
    schemaVersion: "1.1",
    type: "skill",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    displayName: "",
    description: "",
    author: userEmail ?? "",
  };
}

export const DEFAULT_SKILL_CONTENT = "---\nname: \ndescription: \n---\n\n";

// ─── Runtime tools (manifest.runtimeTools) ──────────────────

/**
 * Read the agent manifest's top-level `runtimeTools: string[]` — the
 * built-in runtime tools the agent author opted into (all opt-in,
 * `output` included). Tolerates a missing or malformed field by
 * returning an empty array.
 */
export function getRuntimeTools(m: Record<string, unknown>): string[] {
  const raw = m.runtimeTools;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Write the selected runtime tool ids back into the manifest. An empty
 * selection drops the field entirely so the manifest stays minimal.
 */
export function setRuntimeTools(m: Record<string, unknown>, tools: string[]): void {
  if (tools.length > 0) {
    m.runtimeTools = tools;
  } else {
    delete m.runtimeTools;
  }
}

// ─── Manifest accessors ─────────────────────────────────────

export function getManifestName(m: Record<string, unknown>): { scope: string; id: string } {
  const raw = (m.name as string) || "";
  const match = raw.match(/^@([^/]+)\/(.*)$/);
  return match ? { scope: match[1]!, id: match[2]! } : { scope: "", id: raw };
}

/** Extract MetadataState from a manifest object. Includes timeout if present (agents only). */
export function manifestToMetadata(m: Record<string, unknown>): MetadataState {
  const { scope, id } = getManifestName(m);
  return {
    id,
    scope,
    version: (m.version as string) ?? "1.0.0",
    displayName: (m.displayName as string) ?? "",
    description: (m.description as string) ?? "",
    author: (m.author as string) ?? "",
    keywords: Array.isArray(m.keywords) ? (m.keywords as string[]) : [],
    ...(typeof m.timeout === "number" ? { timeout: m.timeout } : {}),
  };
}

/** Apply MetadataState changes back into a manifest patch. */
export function metadataToManifestPatch(m: MetadataState): Record<string, unknown> {
  return {
    name: m.scope ? `@${m.scope}/${m.id}` : m.id,
    version: m.version,
    displayName: m.displayName,
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
  // Integrations: version from `dependencies.integrations`, tools/scopes
  // from the top-level `integrations` block (niveau 2 scope model).
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
  type ManifestWrapper = {
    schema?: JSONSchemaObject;
    fileConstraints?: Record<string, { accept?: string; maxSize?: number }>;
    uiHints?: Record<string, { placeholder?: string }>;
    propertyOrder?: string[];
  };
  const wrapperFor = (key: string) => manifest[key] as ManifestWrapper | undefined;
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
    fileConstraints?: Record<string, FileConstraint>;
    uiHints?: Record<string, UIHint>;
    propertyOrder?: string[];
  },
): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredSet = new Set(schema.required || []);
  const keys = getOrderedKeys(schema, wrapper?.propertyOrder);
  return keys.map((key) => {
    const prop = schema.properties[key]!;
    const fileField = isFileField(prop);
    const isInputFile = mode === "input" && fileField;
    const constraints = wrapper?.fileConstraints?.[key];
    const hint = wrapper?.uiHints?.[key];
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
            maxSize: constraints?.maxSize != null ? String(constraints.maxSize) : "",
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
  const fileConstraints: Record<string, FileConstraint> = {};
  const uiHints: Record<string, UIHint> = {};
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
      // Build fileConstraints
      const constraint: FileConstraint = {};
      if (f.accept) constraint.accept = f.accept;
      if (f.maxSize) {
        const n = Number(f.maxSize);
        if (!isNaN(n)) constraint.maxSize = n;
      }
      if (Object.keys(constraint).length > 0) fileConstraints[key] = constraint;
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
      // Build uiHints for placeholder
      if (mode === "input" && f.placeholder) {
        uiHints[key] = { placeholder: f.placeholder };
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
    ...(Object.keys(fileConstraints).length > 0 ? { fileConstraints } : {}),
    ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
    propertyOrder: filtered.map((f) => f.key.trim()),
  };
}
