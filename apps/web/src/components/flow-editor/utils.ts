import type { FlowEditorState, ProviderEntry, ResourceEntry } from "./types";
import type { MetadataState } from "./metadata-section";
import type { SchemaField } from "./schema-section";
import type { JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";
import { getOrderedKeys } from "@appstrate/shared-types";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";

// ─── Default state ──────────────────────────────────────────

export function defaultEditorState(orgSlug?: string, userEmail?: string): FlowEditorState {
  return {
    manifest: {
      $schema: AFPS_SCHEMA_URLS.flow,
      schemaVersion: "1.0",
      type: "flow",
      name: orgSlug ? `@${orgSlug}/` : "",
      version: "1.0.0",
      displayName: "",
      description: "",
      author: userEmail ?? "",
      timeout: 300,
      dependencies: {
        providers: {},
        tools: {
          "@appstrate/log": "*",
          "@appstrate/output": "*",
          "@appstrate/set-state": "*",
          "@appstrate/add-memory": "*",
        },
      },
    },
    prompt: "",
  };
}

// ─── Manifest accessors ─────────────────────────────────────

export function getManifestName(m: Record<string, unknown>): { scope: string; id: string } {
  const raw = (m.name as string) || "";
  const match = raw.match(/^@([^/]+)\/(.*)$/);
  return match ? { scope: match[1], id: match[2] } : { scope: "", id: raw };
}

/** Extract MetadataState from a manifest object. Includes timeout if present (flows only). */
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

export function getProviderEntries(m: Record<string, unknown>): ProviderEntry[] {
  const deps = getDeps(m);
  const providers = (deps.providers ?? {}) as Record<string, string>;
  const config = (m.providersConfiguration ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(providers).map(([id, version]) => {
    const cfg = config[id] ?? {};
    return {
      id,
      version: version || "*",
      scopes: Array.isArray(cfg.scopes) ? (cfg.scopes as string[]) : [],
      connectionMode: (cfg.connectionMode as "user" | "admin") || "user",
    };
  });
}

export function setProviderEntries(m: Record<string, unknown>, entries: ProviderEntry[]): void {
  if (!m.dependencies) m.dependencies = { providers: {} };
  const deps = m.dependencies as Record<string, unknown>;
  const providers: Record<string, string> = {};
  const config: Record<string, Record<string, unknown>> = {};
  for (const e of entries) {
    if (!e.id) continue;
    providers[e.id] = e.version;
    const cfg: Record<string, unknown> = {};
    const scopes = e.scopes.filter(Boolean);
    if (scopes.length > 0) cfg.scopes = scopes;
    if (e.connectionMode !== "user") cfg.connectionMode = e.connectionMode;
    if (Object.keys(cfg).length > 0) config[e.id] = cfg;
  }
  deps.providers = providers;
  if (Object.keys(config).length > 0) {
    m.providersConfiguration = config;
  } else {
    delete m.providersConfiguration;
  }
}

export function getResourceEntries(
  m: Record<string, unknown>,
  type: "skills" | "tools",
): ResourceEntry[] {
  const deps = getDeps(m);
  const record = (deps[type] ?? {}) as Record<string, string>;
  return Object.entries(record).map(([id, version]) => ({ id, version }));
}

export function setResourceEntries(
  m: Record<string, unknown>,
  type: "skills" | "tools",
  entries: ResourceEntry[],
): void {
  if (!m.dependencies) m.dependencies = { providers: {} };
  const deps = m.dependencies as Record<string, unknown>;
  const record: Record<string, string> = {};
  for (const e of entries) {
    if (e.id) record[e.id] = e.version;
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

// ─── Schema field conversion (used by SchemaSection) ────────

function convertDefaultValue(value: string, type: string): unknown {
  if (!value) return undefined;
  if (type === "number") {
    const n = Number(value);
    return isNaN(n) ? value : n;
  }
  if (type === "boolean") return value === "true";
  return value;
}

export function schemaToFields(
  schema: JSONSchemaObject | undefined,
  mode: "input" | "output" | "config" | "credentials",
): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredSet = new Set(schema.required || []);
  const keys = getOrderedKeys(schema);
  return keys.map((key) => {
    const prop = schema.properties[key];
    return {
      _id: crypto.randomUUID(),
      key,
      type: prop.type || "string",
      description: prop.description || "",
      required: requiredSet.has(key),
      ...(mode === "input" && prop.type === "file"
        ? {
            accept: prop.accept || "",
            maxSize: prop.maxSize != null ? String(prop.maxSize) : "",
            multiple: prop.multiple ?? false,
            maxFiles: prop.maxFiles != null ? String(prop.maxFiles) : "",
          }
        : {}),
      ...(mode === "input" && prop.type !== "file"
        ? {
            placeholder: prop.placeholder || "",
            default: prop.default != null ? String(prop.default) : "",
          }
        : {}),
      ...(mode === "config"
        ? {
            default: prop.default != null ? String(prop.default) : "",
            enumValues: Array.isArray(prop.enum) ? prop.enum.join(", ") : "",
          }
        : {}),
    };
  });
}

export function fieldsToSchema(
  fields: SchemaField[],
  mode: "input" | "output" | "config" | "credentials",
): JSONSchemaObject | null {
  const filtered = fields.filter((f) => f.key.trim());
  if (filtered.length === 0) return null;
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];
  for (const f of filtered) {
    const prop: JSONSchemaProperty = { type: f.type };
    if (f.description) prop.description = f.description;
    if (mode === "input" && f.type === "file") {
      if (f.accept) prop.accept = f.accept;
      if (f.maxSize) {
        const n = Number(f.maxSize);
        if (!isNaN(n)) prop.maxSize = n;
      }
      if (f.multiple) prop.multiple = true;
      if (f.multiple && f.maxFiles) {
        const n = Number(f.maxFiles);
        if (!isNaN(n)) prop.maxFiles = n;
      }
    } else {
      if (mode === "input" || mode === "config") {
        const def = convertDefaultValue(f.default || "", f.type);
        if (def !== undefined) prop.default = def;
      }
      if (mode === "input" && f.placeholder) prop.placeholder = f.placeholder;
    }
    if (mode === "config") {
      const enumVals = f.enumValues
        ?.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (enumVals && enumVals.length > 0) prop.enum = enumVals;
    }
    if (f.required) required.push(f.key.trim());
    properties[f.key.trim()] = prop;
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    propertyOrder: filtered.map((f) => f.key.trim()),
  };
}
