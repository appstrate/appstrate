import type { FlowFormState } from "./types";
import type { ServiceEntry } from "./services-section";
import type { SchemaField } from "./schema-section";
import type { FlowDetail, JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";

export function defaultFormState(): FlowFormState {
  return {
    metadata: { name: "", displayName: "", description: "", tags: [] },
    prompt: "",
    services: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    stateSchema: [],
    execution: { timeout: 300, maxTokens: 8192, outputRetries: 2 },
    skills: [],
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
  mode: "input" | "output" | "config" | "state",
): SchemaField[] {
  if (!schema?.properties) return [];
  const requiredSet = new Set(schema.required || []);
  return Object.entries(schema.properties).map(([key, prop]) => ({
    key,
    type: prop.type || "string",
    description: prop.description || "",
    required: requiredSet.has(key),
    ...(mode === "input"
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
    ...(mode === "state" ? { format: prop.format || "" } : {}),
  }));
}

export function fieldsToSchema(
  fields: SchemaField[],
  mode: "input" | "output" | "config" | "state",
): JSONSchemaObject | null {
  const filtered = fields.filter((f) => f.key.trim());
  if (filtered.length === 0) return null;
  const properties: Record<string, JSONSchemaProperty> = {};
  const required: string[] = [];
  for (const f of filtered) {
    const prop: JSONSchemaProperty = { type: f.type };
    if (mode !== "state" && f.description) prop.description = f.description;
    if (mode === "input" || mode === "config") {
      const def = convertDefaultValue(f.default || "", f.type);
      if (def !== undefined) prop.default = def;
    }
    if (mode === "input" && f.placeholder) prop.placeholder = f.placeholder;
    if (mode === "config") {
      const enumVals = f.enumValues
        ?.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (enumVals && enumVals.length > 0) prop.enum = enumVals;
    }
    if (mode === "state" && f.format) prop.format = f.format;
    if (f.required) required.push(f.key.trim());
    properties[f.key.trim()] = prop;
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

export function detailToFormState(detail: FlowDetail): FlowFormState {
  const services: ServiceEntry[] = detail.requires.services.map((s) => ({
    id: s.id,
    provider: s.provider,
    description: s.description,
    scopes: "",
  }));

  return {
    metadata: {
      name: detail.id,
      displayName: detail.displayName,
      description: detail.description,
      tags: detail.tags || [],
    },
    prompt: detail.prompt || "",
    services,
    inputSchema: schemaToFields(detail.input?.schema, "input"),
    outputSchema: schemaToFields(detail.output?.schema, "output"),
    configSchema: schemaToFields(detail.config?.schema, "config"),
    stateSchema: schemaToFields(detail.stateSchema?.schema, "state"),
    execution: {
      timeout: detail.executionSettings?.timeout ?? 300,
      maxTokens: detail.executionSettings?.maxTokens ?? 8192,
      outputRetries: detail.executionSettings?.outputRetries ?? 2,
    },
    skills: detail.rawSkills || [],
  };
}

export function assemblePayload(state: FlowFormState, userEmail: string) {
  const manifest: Record<string, unknown> = {
    version: "1.0",
    metadata: {
      name: state.metadata.name,
      displayName: state.metadata.displayName,
      description: state.metadata.description,
      author: userEmail,
      ...(state.metadata.tags.length > 0 ? { tags: state.metadata.tags } : {}),
    },
    requires: {
      services: state.services
        .filter((s) => s.id && s.provider)
        .map((s) => {
          const svc: Record<string, unknown> = {
            id: s.id,
            provider: s.provider,
            description: s.description,
          };
          const scopes = s.scopes
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          if (scopes.length > 0) svc.scopes = scopes;
          return svc;
        }),
    },
  };

  const inputSchema = fieldsToSchema(state.inputSchema, "input");
  if (inputSchema) manifest.input = { schema: inputSchema };

  const outputSchema = fieldsToSchema(state.outputSchema, "output");
  if (outputSchema) manifest.output = { schema: outputSchema };

  const configSchema = fieldsToSchema(state.configSchema, "config");
  if (configSchema) manifest.config = { schema: configSchema };

  const stateSchema = fieldsToSchema(state.stateSchema, "state");
  if (stateSchema) manifest.state = { schema: stateSchema };

  manifest.execution = {
    timeout: state.execution.timeout,
    maxTokens: state.execution.maxTokens,
    outputRetries: state.execution.outputRetries,
  };

  const skills = state.skills
    .filter((s) => s.id && s.content)
    .map((s) => ({ id: s.id, description: s.description, content: s.content }));

  return { manifest, prompt: state.prompt, skills };
}

export function payloadToFormState(payload: {
  manifest: Record<string, unknown>;
  prompt: string;
  skills: Array<{ id: string; description: string; content: string }>;
}): FlowFormState {
  const { manifest, prompt, skills } = payload;
  const meta = (manifest.metadata as Record<string, unknown>) || {};
  const requires = (manifest.requires as Record<string, unknown>) || {};
  const rawServices = (requires.services as Array<Record<string, unknown>>) || [];
  const execution = (manifest.execution as Record<string, unknown>) || {};

  const services: ServiceEntry[] = rawServices.map((s) => ({
    id: (s.id as string) || "",
    provider: (s.provider as string) || "",
    description: (s.description as string) || "",
    scopes: Array.isArray(s.scopes) ? s.scopes.join(", ") : "",
  }));

  const inputObj = manifest.input as { schema?: JSONSchemaObject } | undefined;
  const outputObj = manifest.output as { schema?: JSONSchemaObject } | undefined;
  const configObj = manifest.config as { schema?: JSONSchemaObject } | undefined;
  const stateObj = manifest.state as { schema?: JSONSchemaObject } | undefined;

  return {
    metadata: {
      name: (meta.name as string) || "",
      displayName: (meta.displayName as string) || "",
      description: (meta.description as string) || "",
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    },
    prompt,
    services,
    inputSchema: schemaToFields(inputObj?.schema, "input"),
    outputSchema: schemaToFields(outputObj?.schema, "output"),
    configSchema: schemaToFields(configObj?.schema, "config"),
    stateSchema: schemaToFields(stateObj?.schema, "state"),
    execution: {
      timeout: (execution.timeout as number) ?? 300,
      maxTokens: (execution.maxTokens as number) ?? 8192,
      outputRetries: (execution.outputRetries as number) ?? 2,
    },
    skills: skills.map((s) => ({ id: s.id, description: s.description, content: s.content })),
  };
}
