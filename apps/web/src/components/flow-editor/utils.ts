import type { FlowFormState, ServiceEntry, ResourceEntry } from "./types";
import type { SchemaField } from "./schema-section";
import type { FlowDetail, JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";

export function toResourceEntry(r: {
  id: string;
  name?: string;
  description?: string;
}): ResourceEntry {
  return { id: r.id, name: r.name, description: r.description };
}

export function defaultFormState(): FlowFormState {
  return {
    metadata: { name: "", displayName: "", description: "", tags: [] },
    prompt: "",
    services: [],
    skills: [],
    extensions: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    execution: { timeout: 300, maxTokens: 8192, outputRetries: 2 },
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
  return Object.entries(schema.properties).map(([key, prop]) => ({
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
  }));
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
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

export function detailToFormState(detail: FlowDetail): FlowFormState {
  const services: ServiceEntry[] = detail.requires.services.map((s) => ({
    id: s.id,
    provider: s.provider,
    description: s.description,
    scopes: "",
    connectionMode: s.connectionMode === "admin" ? "admin" : "user",
    credentialSchema: s.provider === "custom" ? schemaToFields(s.schema, "credentials") : [],
    authorizedUris: s.authorizedUris?.join("\n") ?? "",
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
    skills: (detail.requires.skills ?? []).map(toResourceEntry),
    extensions: (detail.requires.extensions ?? []).map(toResourceEntry),
    inputSchema: schemaToFields(detail.input?.schema, "input"),
    outputSchema: schemaToFields(detail.output?.schema, "output"),
    configSchema: schemaToFields(detail.config?.schema, "config"),
    execution: {
      timeout: detail.executionSettings?.timeout ?? 300,
      maxTokens: detail.executionSettings?.maxTokens ?? 8192,
      outputRetries: detail.executionSettings?.outputRetries ?? 2,
    },
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
          svc.connectionMode = s.connectionMode || "user";
          if (s.provider === "custom") {
            const schema = fieldsToSchema(s.credentialSchema, "credentials");
            if (schema) svc.schema = schema;
          }
          const uris = s.authorizedUris
            .split(/[,\n]/)
            .map((u) => u.trim())
            .filter(Boolean);
          if (uris.length > 0) svc.authorized_uris = uris;
          return svc;
        }),
      skills: state.skills,
      extensions: state.extensions,
    },
  };

  const inputSchema = fieldsToSchema(state.inputSchema, "input");
  if (inputSchema) manifest.input = { schema: inputSchema };

  const outputSchema = fieldsToSchema(state.outputSchema, "output");
  if (outputSchema) manifest.output = { schema: outputSchema };

  const configSchema = fieldsToSchema(state.configSchema, "config");
  if (configSchema) manifest.config = { schema: configSchema };

  manifest.execution = {
    timeout: state.execution.timeout,
    maxTokens: state.execution.maxTokens,
    outputRetries: state.execution.outputRetries,
  };

  return {
    manifest,
    prompt: state.prompt,
    skillIds: state.skills.map((s) => s.id).filter(Boolean),
    extensionIds: state.extensions.map((e) => e.id).filter(Boolean),
  };
}

export function payloadToFormState(payload: {
  manifest: Record<string, unknown>;
  prompt: string;
}): FlowFormState {
  const { manifest, prompt } = payload;
  const meta = (manifest.metadata as Record<string, unknown>) || {};
  const requires = (manifest.requires as Record<string, unknown>) || {};
  const rawServices = (requires.services as Array<Record<string, unknown>>) || [];
  const execution = (manifest.execution as Record<string, unknown>) || {};

  const services: ServiceEntry[] = rawServices.map((s) => {
    const provider = (s.provider as string) || "";
    return {
      id: (s.id as string) || "",
      provider,
      description: (s.description as string) || "",
      scopes: Array.isArray(s.scopes) ? s.scopes.join(", ") : "",
      connectionMode: (s.connectionMode as "user" | "admin") || "user",
      credentialSchema:
        provider === "custom"
          ? schemaToFields(s.schema as JSONSchemaObject | undefined, "credentials")
          : [],
      authorizedUris: Array.isArray(s.authorized_uris)
        ? (s.authorized_uris as string[]).join("\n")
        : "",
    };
  });

  const rawSkills = (requires.skills as Array<Record<string, unknown>>) || [];
  const skills = rawSkills.map((s) =>
    toResourceEntry({
      id: (s.id as string) || "",
      name: s.name as string | undefined,
      description: s.description as string | undefined,
    }),
  );

  const rawExtensions = (requires.extensions as Array<Record<string, unknown>>) || [];
  const extensions = rawExtensions.map((e) =>
    toResourceEntry({
      id: (e.id as string) || "",
      name: e.name as string | undefined,
      description: e.description as string | undefined,
    }),
  );

  const inputObj = manifest.input as { schema?: JSONSchemaObject } | undefined;
  const outputObj = manifest.output as { schema?: JSONSchemaObject } | undefined;
  const configObj = manifest.config as { schema?: JSONSchemaObject } | undefined;

  return {
    metadata: {
      name: (meta.name as string) || "",
      displayName: (meta.displayName as string) || "",
      description: (meta.description as string) || "",
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
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
      maxTokens: (execution.maxTokens as number) ?? 8192,
      outputRetries: (execution.outputRetries as number) ?? 2,
    },
  };
}
