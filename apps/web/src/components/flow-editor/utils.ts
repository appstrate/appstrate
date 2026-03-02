import type { FlowFormState, ServiceEntry, ResourceEntry } from "./types";
import type { SchemaField } from "./schema-section";
import type { FlowDetail, JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";
import { getOrderedKeys } from "@appstrate/shared-types";

export function toResourceEntry(r: {
  id: string;
  name?: string;
  description?: string;
}): ResourceEntry {
  return { id: r.id, name: r.name, description: r.description };
}

export function defaultFormState(orgSlug?: string, userEmail?: string): FlowFormState {
  return {
    metadata: {
      id: "",
      scope: orgSlug ?? "",
      version: "1.0.0",
      displayName: "",
      description: "",
      author: userEmail ?? "",
      tags: [],
    },
    prompt: "",
    services: [],
    skills: [],
    extensions: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    execution: { timeout: 300, outputRetries: 2 },
    _manifestBase: { schemaVersion: "1.0", type: "flow" },
  };
}

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

export function detailToFormState(detail: FlowDetail): FlowFormState {
  // Editor only handles user flows — manifest is always present
  const m = (detail.manifest ?? {}) as Record<string, unknown>;

  const rawName = (m.name as string) ?? "";
  const scopeMatch = rawName.match(/^@([^/]+)\/(.+)$/);
  const bareName = scopeMatch
    ? scopeMatch[2]
    : detail.id.split("--").length > 1
      ? detail.id.split("--").slice(1).join("--")
      : detail.id;

  // Services: read from raw manifest (has scopes, description, etc.)
  const rawRequires = (m.requires ?? {}) as Record<string, unknown>;
  const rawServices = (rawRequires.services ?? []) as Array<Record<string, unknown>>;
  const services: ServiceEntry[] = rawServices.map((s) => ({
    id: (s.id as string) || "",
    provider: (s.provider as string) || "",
    scopes: Array.isArray(s.scopes) ? (s.scopes as string[]) : [],
    connectionMode: (s.connectionMode as "user" | "admin") || "user",
  }));

  // Execution: read from raw manifest (preserves maxTokens, etc.)
  const rawExecution = (m.execution ?? {}) as Record<string, unknown>;

  return {
    metadata: {
      id: bareName,
      scope: scopeMatch ? scopeMatch[1] : "",
      version: (m.version as string) ?? "1.0.0",
      displayName: (m.displayName as string) ?? "",
      description: (m.description as string) ?? "",
      author: (m.author as string) ?? "",
      tags: (m.tags as string[]) ?? [],
    },
    prompt: detail.prompt || "",
    services,
    skills: (detail.requires.skills ?? []).map(toResourceEntry),
    extensions: (detail.requires.extensions ?? []).map(toResourceEntry),
    inputSchema: schemaToFields(detail.input?.schema, "input"),
    outputSchema: schemaToFields(detail.output?.schema, "output"),
    configSchema: schemaToFields(detail.config?.schema, "config"),
    execution: {
      timeout: (rawExecution.timeout as number) ?? 300,
      outputRetries: (rawExecution.outputRetries as number) ?? 2,
    },
    _manifestBase: { ...m },
  };
}

/**
 * Merge form-derived schema with original schema, preserving
 * properties the form doesn't track (format, pattern, etc.).
 */
function mergeSchemaWithBase(
  formSchema: JSONSchemaObject | null,
  baseContainer: { schema?: JSONSchemaObject } | undefined,
): JSONSchemaObject | null {
  if (!formSchema) return null;
  const baseProps = baseContainer?.schema?.properties;
  if (!baseProps) return formSchema;

  const merged: Record<string, JSONSchemaProperty> = {};
  for (const [key, formProp] of Object.entries(formSchema.properties)) {
    const baseProp = baseProps[key];
    merged[key] = baseProp ? { ...baseProp, ...formProp } : formProp;
  }

  return { ...formSchema, properties: merged };
}

export function assemblePayload(state: FlowFormState) {
  const baseRequires = (state._manifestBase.requires ?? {}) as Record<string, unknown>;
  const baseServices = (baseRequires.services ?? []) as Array<Record<string, unknown>>;

  const filteredSkills = state.skills.map((s) => s.id).filter(Boolean);
  const filteredExtensions = state.extensions.map((e) => e.id).filter(Boolean);

  const requires: Record<string, unknown> = {
    ...baseRequires, // Preserve unknown fields in requires
    services: state.services
      .filter((s) => s.id && s.provider)
      .map((s) => {
        // Find original service to preserve description, etc.
        const original = baseServices.find((bs) => (bs.id as string) === s.id) ?? {};
        const svc: Record<string, unknown> = {
          ...original,
          id: s.id,
          provider: s.provider,
        };
        // connectionMode: write only if present in original or non-default
        if ("connectionMode" in original || s.connectionMode !== "user") {
          svc.connectionMode = s.connectionMode || "user";
        } else {
          delete svc.connectionMode;
        }
        // scopes: write only if present in original or non-empty
        const scopes = s.scopes.filter(Boolean);
        if ("scopes" in original || scopes.length > 0) {
          svc.scopes = scopes;
        } else {
          delete svc.scopes;
        }
        return svc;
      }),
  };
  if ("skills" in baseRequires || filteredSkills.length > 0) {
    requires.skills = filteredSkills;
  } else {
    delete requires.skills;
  }
  if ("extensions" in baseRequires || filteredExtensions.length > 0) {
    requires.extensions = filteredExtensions;
  } else {
    delete requires.extensions;
  }

  const manifest: Record<string, unknown> = {
    ...state._manifestBase,
    name: `@${state.metadata.scope}/${state.metadata.id}`,
    version: state.metadata.version,
    displayName: state.metadata.displayName,
    description: state.metadata.description,
    author: state.metadata.author,
    requires,
  };

  // tags: write only if present in original or non-empty
  if ("tags" in state._manifestBase || state.metadata.tags.length > 0) {
    manifest.tags = state.metadata.tags;
  } else {
    delete manifest.tags;
  }

  // Override or delete input/output/config based on form state
  // Merge with base schema to preserve properties the form doesn't track (format, pattern, etc.)
  const inputSchema = mergeSchemaWithBase(
    fieldsToSchema(state.inputSchema, "input"),
    state._manifestBase.input as { schema?: JSONSchemaObject } | undefined,
  );
  if (inputSchema) {
    manifest.input = { schema: inputSchema };
  } else {
    delete manifest.input;
  }

  const outputSchema = mergeSchemaWithBase(
    fieldsToSchema(state.outputSchema, "output"),
    state._manifestBase.output as { schema?: JSONSchemaObject } | undefined,
  );
  if (outputSchema) {
    manifest.output = { schema: outputSchema };
  } else {
    delete manifest.output;
  }

  const configSchema = mergeSchemaWithBase(
    fieldsToSchema(state.configSchema, "config"),
    state._manifestBase.config as { schema?: JSONSchemaObject } | undefined,
  );
  if (configSchema) {
    manifest.config = { schema: configSchema };
  } else {
    delete manifest.config;
  }

  // Merge execution with base to preserve custom fields (maxTokens, etc.)
  // Only write if present in original or user changed from defaults
  if (
    "execution" in state._manifestBase ||
    state.execution.timeout !== 300 ||
    state.execution.outputRetries !== 2
  ) {
    const baseExecution = (state._manifestBase.execution ?? {}) as Record<string, unknown>;
    manifest.execution = {
      ...baseExecution,
      timeout: state.execution.timeout,
      outputRetries: state.execution.outputRetries,
    };
  } else {
    delete manifest.execution;
  }

  return {
    manifest,
    prompt: state.prompt,
  };
}

export function payloadToFormState(payload: {
  manifest: Record<string, unknown>;
  prompt: string;
}): FlowFormState {
  const { manifest, prompt } = payload;
  const requires = (manifest.requires as Record<string, unknown>) || {};
  const rawServices = (requires.services as Array<Record<string, unknown>>) || [];
  const execution = (manifest.execution as Record<string, unknown>) || {};

  const services: ServiceEntry[] = rawServices.map((s) => ({
    id: (s.id as string) || "",
    provider: (s.provider as string) || "",
    scopes: Array.isArray(s.scopes) ? (s.scopes as string[]) : [],
    connectionMode: (s.connectionMode as "user" | "admin") || "user",
  }));

  const rawSkills = (requires.skills as string[]) || [];
  const skills = rawSkills.map((id) => toResourceEntry({ id }));

  const rawExtensions = (requires.extensions as string[]) || [];
  const extensions = rawExtensions.map((id) => toResourceEntry({ id }));

  const inputObj = manifest.input as { schema?: JSONSchemaObject } | undefined;
  const outputObj = manifest.output as { schema?: JSONSchemaObject } | undefined;
  const configObj = manifest.config as { schema?: JSONSchemaObject } | undefined;

  const rawName = (manifest.name as string) || "";
  const scopeMatch = rawName.match(/^@([^/]+)\/(.+)$/);

  return {
    metadata: {
      id: scopeMatch ? scopeMatch[2] : rawName,
      scope: scopeMatch ? scopeMatch[1] : "",
      version: (manifest.version as string) || "1.0.0",
      displayName: (manifest.displayName as string) || "",
      description: (manifest.description as string) || "",
      author: (manifest.author as string) || "",
      tags: Array.isArray(manifest.tags) ? (manifest.tags as string[]) : [],
    },
    prompt,
    services,
    skills,
    extensions,
    inputSchema: schemaToFields(inputObj?.schema, "input"),
    outputSchema: schemaToFields(outputObj?.schema, "output"),
    configSchema: schemaToFields(configObj?.schema, "config"),
    execution: {
      timeout: (execution.timeout as number) ?? 300,
      outputRetries: (execution.outputRetries as number) ?? 2,
    },
    _manifestBase: { ...manifest },
  };
}
