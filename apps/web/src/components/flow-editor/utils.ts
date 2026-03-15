import type { FlowFormState, ProviderEntry, ResourceEntry } from "./types";
import type { SchemaField } from "./schema-section";
import type { FlowDetail, JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";
import { getOrderedKeys } from "@appstrate/shared-types";

export function toResourceEntry(r: {
  id: string;
  version?: string;
  name?: string;
  description?: string;
}): ResourceEntry {
  return { id: r.id, version: r.version ?? "*", name: r.name, description: r.description };
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
      keywords: [],
    },
    prompt: "",
    providers: [],
    skills: [],
    tools: [],
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

  // Providers: read from dependencies.providers Record + providersConfiguration
  const rawDependencies = (m.dependencies ?? {}) as Record<string, unknown>;
  const rawProvidersRecord = (rawDependencies.providers ?? {}) as Record<string, string>;
  const rawProvidersConfig = ((m as Record<string, unknown>).providersConfiguration ??
    {}) as Record<string, Record<string, unknown>>;
  const providers: ProviderEntry[] = Object.entries(rawProvidersRecord).map(
    ([providerId, version]) => {
      const cfg = rawProvidersConfig[providerId] ?? {};
      return {
        id: providerId,
        version: (version as string) || "*",
        scopes: Array.isArray(cfg.scopes) ? (cfg.scopes as string[]) : [],
        connectionMode: (cfg.connectionMode as "user" | "admin") || "user",
      };
    },
  );

  return {
    metadata: {
      id: bareName,
      scope: scopeMatch ? scopeMatch[1] : "",
      version: (m.version as string) ?? "1.0.0",
      displayName: (m.displayName as string) ?? "",
      description: (m.description as string) ?? "",
      author: (m.author as string) ?? "",
      keywords: Array.isArray(m.keywords) ? (m.keywords as string[]) : [],
    },
    prompt: detail.prompt || "",
    providers,
    skills: (detail.dependencies.skills ?? []).map(toResourceEntry),
    tools: (detail.dependencies.tools ?? []).map(toResourceEntry),
    inputSchema: schemaToFields(detail.input?.schema, "input"),
    outputSchema: schemaToFields(detail.output?.schema, "output"),
    configSchema: schemaToFields(detail.config?.schema, "config"),
    execution: {
      timeout: (m.timeout as number) ?? 300,
      outputRetries: (m.outputRetries as number) ?? 2,
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
  const baseDependencies = (state._manifestBase.dependencies ?? {}) as Record<string, unknown>;

  const filteredSkills: Record<string, string> = {};
  for (const s of state.skills) {
    if (s.id) filteredSkills[s.id] = s.version;
  }
  const filteredTools: Record<string, string> = {};
  for (const e of state.tools) {
    if (e.id) filteredTools[e.id] = e.version;
  }

  // Build providers Record and providersConfiguration
  const filteredProviders: Record<string, string> = {};
  const providersConfiguration: Record<string, Record<string, unknown>> = {};
  for (const s of state.providers) {
    if (!s.id) continue;
    filteredProviders[s.id] = s.version;
    const cfg: Record<string, unknown> = {};
    const scopes = s.scopes.filter(Boolean);
    if (scopes.length > 0) cfg.scopes = scopes;
    if (s.connectionMode !== "user") cfg.connectionMode = s.connectionMode;
    if (Object.keys(cfg).length > 0) providersConfiguration[s.id] = cfg;
  }

  const dependencies: Record<string, unknown> = {
    ...baseDependencies, // Preserve unknown fields in dependencies
    providers: filteredProviders,
  };
  if ("skills" in baseDependencies || Object.keys(filteredSkills).length > 0) {
    dependencies.skills = filteredSkills;
  } else {
    delete dependencies.skills;
  }
  if ("tools" in baseDependencies || Object.keys(filteredTools).length > 0) {
    dependencies.tools = filteredTools;
  } else {
    delete dependencies.tools;
  }

  const manifest: Record<string, unknown> = {
    ...state._manifestBase,
    name: `@${state.metadata.scope}/${state.metadata.id}`,
    version: state.metadata.version,
    displayName: state.metadata.displayName,
    description: state.metadata.description,
    author: state.metadata.author,
    dependencies,
  };

  // keywords: write only if present in original or non-empty
  if ("keywords" in state._manifestBase || state.metadata.keywords.length > 0) {
    manifest.keywords = state.metadata.keywords;
  } else {
    delete manifest.keywords;
  }

  // providersConfiguration: write only if non-empty
  if (Object.keys(providersConfiguration).length > 0) {
    manifest.providersConfiguration = providersConfiguration;
  } else {
    delete manifest.providersConfiguration;
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

  // Write timeout/outputRetries at top level (only if non-default or present in base)
  if ("timeout" in state._manifestBase || state.execution.timeout !== 300) {
    manifest.timeout = state.execution.timeout;
  } else {
    delete manifest.timeout;
  }
  if ("outputRetries" in state._manifestBase || state.execution.outputRetries !== 2) {
    manifest.outputRetries = state.execution.outputRetries;
  } else {
    delete manifest.outputRetries;
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
  const dependencies = (manifest.dependencies as Record<string, unknown>) || {};
  const rawProvidersRecord = (dependencies.providers ?? {}) as Record<string, string>;
  const rawProvidersConfig = ((manifest as Record<string, unknown>).providersConfiguration ??
    {}) as Record<string, Record<string, unknown>>;
  const providers: ProviderEntry[] = Object.entries(rawProvidersRecord).map(
    ([providerId, version]) => {
      const cfg = rawProvidersConfig[providerId] ?? {};
      return {
        id: providerId,
        version: (version as string) || "*",
        scopes: Array.isArray(cfg.scopes) ? (cfg.scopes as string[]) : [],
        connectionMode: (cfg.connectionMode as "user" | "admin") || "user",
      };
    },
  );

  const rawSkills = (dependencies.skills ?? {}) as Record<string, string>;
  const skills = Object.entries(rawSkills).map(([id, version]) => toResourceEntry({ id, version }));

  const rawTools = (dependencies.tools ?? {}) as Record<string, string>;
  const tools = Object.entries(rawTools).map(([id, version]) => toResourceEntry({ id, version }));

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
      keywords: Array.isArray(manifest.keywords) ? (manifest.keywords as string[]) : [],
    },
    prompt,
    providers,
    skills,
    tools,
    inputSchema: schemaToFields(inputObj?.schema, "input"),
    outputSchema: schemaToFields(outputObj?.schema, "output"),
    configSchema: schemaToFields(configObj?.schema, "config"),
    execution: {
      timeout: (manifest.timeout as number) ?? 300,
      outputRetries: (manifest.outputRetries as number) ?? 2,
    },
    _manifestBase: { ...manifest },
  };
}
