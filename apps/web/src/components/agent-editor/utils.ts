// SPDX-License-Identifier: Apache-2.0

import type { AgentEditorState, ProviderEntry, ResourceEntry } from "./types";
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

// ─── Default state ──────────────────────────────────────────

export function defaultEditorState(orgSlug?: string, userEmail?: string): AgentEditorState {
  return {
    manifest: {
      $schema: AFPS_SCHEMA_URLS.agent,
      schemaVersion: "1.0",
      type: "agent",
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
          "@appstrate/report": "*",
          "@appstrate/set-state": "*",
          "@appstrate/add-memory": "*",
        },
      },
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
    schemaVersion: "1.0",
    type: "skill",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    displayName: "",
    description: "",
    author: userEmail ?? "",
  };
}

export function defaultToolManifest(orgSlug?: string, userEmail?: string): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.tool,
    schemaVersion: "1.0",
    type: "tool",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    displayName: "",
    description: "",
    author: userEmail ?? "",
    entrypoint: "tool.ts",
    tool: {
      name: "my_tool",
      description: "Tool",
      inputSchema: { type: "object", properties: {} },
    },
  };
}

export function defaultProviderManifest(
  orgSlug?: string,
  userEmail?: string,
): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.provider,
    schemaVersion: "1.0",
    type: "provider",
    name: orgSlug ? `@${orgSlug}/` : "",
    version: "1.0.0",
    displayName: "",
    description: "",
    author: userEmail ?? "",
    definition: {
      authMode: "oauth2",
      oauth2: {
        authorizationUrl: "",
        tokenUrl: "",
        scopeSeparator: " ",
        pkceEnabled: true,
        tokenAuthMethod: "client_secret_post",
      },
    },
  };
}

export const DEFAULT_SKILL_CONTENT = "---\nname: \ndescription: \n---\n\n";

export const DEFAULT_TOOL_CONTENT = `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n  pi.registerTool({\n    name: "my_tool",\n    description: "Describe what this tool does",\n    parameters: {},\n    execute(_toolCallId, _params, _signal) {\n      return { content: [{ type: "text", text: "Hello" }] };\n    },\n  });\n}\n`;

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
