import { z } from "zod";
import type { FlowFieldBase, FlowConfigField } from "@appstrate/shared-types";

// --- Section A: Static manifest schema ---

const flowFieldTypeEnum = z.enum(["string", "number", "boolean", "array", "object"]);

const fieldBaseSchema = z.object({
  type: flowFieldTypeEnum,
  description: z.string(),
  required: z.boolean().optional(),
});

const configFieldSchema = fieldBaseSchema.extend({
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
});

const inputFieldSchema = fieldBaseSchema.extend({
  default: z.unknown().optional(),
  placeholder: z.string().optional(),
});

const outputFieldSchema = fieldBaseSchema;

const serviceRequirementSchema = z.object({
  id: z.string(),
  provider: z.string(),
  scopes: z.array(z.string()),
  description: z.string(),
});

const toolRequirementSchema = z.object({
  id: z.string(),
  type: z.enum(["static", "custom"]),
  description: z.string(),
});

const manifestSchema = z.looseObject({
  $schema: z.string().optional(),
  version: z.string(),
  metadata: z.object({
    name: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().min(1),
    author: z.string(),
    license: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  requires: z.object({
    services: z.array(serviceRequirementSchema),
    tools: z.array(toolRequirementSchema).optional(),
  }),
  input: z
    .object({
      schema: z.record(z.string(), inputFieldSchema),
    })
    .optional(),
  output: z
    .object({
      schema: z.record(z.string(), outputFieldSchema),
    })
    .optional(),
  state: z
    .object({
      enabled: z.boolean(),
      schema: z.record(
        z.string(),
        z.object({
          type: z.string(),
          format: z.string().optional(),
        }),
      ),
    })
    .optional(),
  config: z
    .object({
      schema: z.record(z.string(), configFieldSchema),
    })
    .optional(),
  execution: z
    .object({
      timeout: z.number().optional(),
      maxTokens: z.number().optional(),
      outputRetries: z.number().min(0).max(5).optional(),
    })
    .optional(),
});

// --- Section B: Dynamic field schema builder ---

function zodTypeForField(field: FlowFieldBase): z.ZodType {
  switch (field.type) {
    case "string":
      return z.string();
    case "number":
      return z.coerce.number();
    case "boolean":
      return z.coerce.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

function buildFieldsSchema(
  fields: Record<string, FlowFieldBase>,
  options: { strictRequired?: boolean } = {},
): z.ZodObject<Record<string, z.ZodType>> {
  const { strictRequired = true } = options;
  const shape: Record<string, z.ZodType> = {};

  for (const [key, field] of Object.entries(fields)) {
    let schema = zodTypeForField(field);

    // Enum constraint for config fields
    const configField = field as FlowConfigField;
    if (configField.enum && Array.isArray(configField.enum) && configField.enum.length > 0) {
      const values = configField.enum.map((v) => String(v));
      schema = z.enum(values as [string, ...string[]]);
    }

    // Required strings must be non-empty (preserves current behavior: "" = missing)
    if (field.required && strictRequired && field.type === "string" && !configField.enum) {
      schema = z.string().min(1, `Le champ '${key}' ne peut pas être vide`);
    }

    if (!field.required) {
      schema = schema.optional().nullable();
    }

    shape[key] = schema;
  }

  return z.object(shape);
}

// --- Section C: Validation functions ---

export interface ValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
  data?: Record<string, unknown>;
}

export function validateManifest(raw: unknown): {
  valid: boolean;
  errors: string[];
  manifest?: unknown;
} {
  const result = manifestSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, errors: [], manifest: result.data };
  }
  const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  return { valid: false, errors };
}

export function validateConfig(
  data: Record<string, unknown>,
  schema: Record<string, FlowConfigField>,
): ValidationResult {
  if (Object.keys(schema).length === 0) {
    return { valid: true, errors: [], data };
  }

  const zodSchema = buildFieldsSchema(schema);
  const result = zodSchema.safeParse(data);

  if (result.success) {
    return { valid: true, errors: [], data: result.data as Record<string, unknown> };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "unknown",
    message: issue.message,
  }));
  return { valid: false, errors };
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: Record<string, FlowFieldBase>,
): ValidationResult {
  if (Object.keys(schema).length === 0) {
    return { valid: true, errors: [], data: input ?? {} };
  }

  const zodSchema = buildFieldsSchema(schema);
  const result = zodSchema.safeParse(input ?? {});

  if (result.success) {
    return { valid: true, errors: [], data: result.data as Record<string, unknown> };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "unknown",
    message: issue.message,
  }));
  return { valid: false, errors };
}

export function validateOutput(
  result: Record<string, unknown>,
  schema: Record<string, FlowFieldBase>,
): { valid: boolean; errors: string[] } {
  if (Object.keys(schema).length === 0) {
    return { valid: true, errors: [] };
  }

  // Use looseObject to allow extra fields (state, tokensUsed, etc.)
  const zodSchema = z.looseObject(buildFieldsSchema(schema).shape);
  const parsed = zodSchema.safeParse(result);

  if (parsed.success) {
    return { valid: true, errors: [] };
  }

  const errors = parsed.error.issues.map(
    (issue) => `Field '${issue.path.join(".")}': ${issue.message}`,
  );
  return { valid: false, errors };
}
