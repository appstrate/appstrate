import type { FlowFormState } from "./types";
import type { ServiceEntry } from "./services-section";
import type { SchemaField } from "./schema-section";
import type { FlowDetail } from "@appstrate/shared-types";

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

export function recordToFields(
  record: Record<string, Record<string, unknown>> | undefined,
  mode: "input" | "output" | "config" | "state",
): SchemaField[] {
  if (!record) return [];
  return Object.entries(record).map(([key, field]) => ({
    key,
    type: (field.type as string) || "string",
    description: (field.description as string) || "",
    required: !!field.required,
    ...(mode === "input"
      ? {
          placeholder: (field.placeholder as string) || "",
          default: field.default != null ? String(field.default) : "",
        }
      : {}),
    ...(mode === "config"
      ? {
          default: field.default != null ? String(field.default) : "",
          enumValues: Array.isArray(field.enum) ? field.enum.join(", ") : "",
        }
      : {}),
    ...(mode === "state" ? { format: (field.format as string) || "" } : {}),
  }));
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
    inputSchema: recordToFields(
      detail.input?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "input",
    ),
    outputSchema: recordToFields(
      detail.output?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "output",
    ),
    configSchema: recordToFields(
      detail.config?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "config",
    ),
    stateSchema: recordToFields(
      detail.stateSchema?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "state",
    ),
    execution: {
      timeout: detail.executionSettings?.timeout ?? 300,
      maxTokens: detail.executionSettings?.maxTokens ?? 8192,
      outputRetries: detail.executionSettings?.outputRetries ?? 2,
    },
    skills: detail.rawSkills || [],
  };
}

export function fieldsToRecord(
  fields: SchemaField[],
  mode: "input" | "output" | "config" | "state",
): Record<string, Record<string, unknown>> | null {
  const filtered = fields.filter((f) => f.key.trim());
  if (filtered.length === 0) return null;
  const record: Record<string, Record<string, unknown>> = {};
  for (const f of filtered) {
    const entry: Record<string, unknown> = { type: f.type };
    if (mode !== "state") {
      entry.description = f.description;
      entry.required = f.required;
    }
    if (mode === "input") {
      if (f.placeholder) entry.placeholder = f.placeholder;
      if (f.default) entry.default = f.default;
    }
    if (mode === "config") {
      if (f.default) entry.default = f.default;
      const enumVals = f.enumValues
        ?.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (enumVals && enumVals.length > 0) entry.enum = enumVals;
    }
    if (mode === "state") {
      if (f.format) entry.format = f.format;
    }
    record[f.key.trim()] = entry;
  }
  return record;
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

  const inputSchema = fieldsToRecord(state.inputSchema, "input");
  if (inputSchema) manifest.input = { schema: inputSchema };

  const outputSchema = fieldsToRecord(state.outputSchema, "output");
  if (outputSchema) manifest.output = { schema: outputSchema };

  const configSchema = fieldsToRecord(state.configSchema, "config");
  if (configSchema) manifest.config = { schema: configSchema };

  const stateSchema = fieldsToRecord(state.stateSchema, "state");
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

  const inputObj = manifest.input as Record<string, unknown> | undefined;
  const outputObj = manifest.output as Record<string, unknown> | undefined;
  const configObj = manifest.config as Record<string, unknown> | undefined;
  const stateObj = manifest.state as Record<string, unknown> | undefined;

  return {
    metadata: {
      name: (meta.name as string) || "",
      displayName: (meta.displayName as string) || "",
      description: (meta.description as string) || "",
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
    },
    prompt,
    services,
    inputSchema: recordToFields(
      inputObj?.schema as Record<string, Record<string, unknown>> | undefined,
      "input",
    ),
    outputSchema: recordToFields(
      outputObj?.schema as Record<string, Record<string, unknown>> | undefined,
      "output",
    ),
    configSchema: recordToFields(
      configObj?.schema as Record<string, Record<string, unknown>> | undefined,
      "config",
    ),
    stateSchema: recordToFields(
      stateObj?.schema as Record<string, Record<string, unknown>> | undefined,
      "state",
    ),
    execution: {
      timeout: (execution.timeout as number) ?? 300,
      maxTokens: (execution.maxTokens as number) ?? 8192,
      outputRetries: (execution.outputRetries as number) ?? 2,
    },
    skills: skills.map((s) => ({ id: s.id, description: s.description, content: s.content })),
  };
}
