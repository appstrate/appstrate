import { z } from "zod";
import Ajv from "ajv";
import type { JSONSchemaObject, JSONSchemaProperty } from "@appstrate/shared-types";
import type { UploadedFile } from "./adapters/types.ts";

// --- Section A: Static manifest schema ---

export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const flowFieldTypeEnum = z.enum(["string", "number", "boolean", "array", "object", "file"]);

const jsonSchemaPropertySchema = z.object({
  type: flowFieldTypeEnum,
  description: z.string().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  format: z.string().optional(),
  placeholder: z.string().optional(),
  accept: z.string().optional(),
  maxSize: z.number().positive().optional(),
  multiple: z.boolean().optional(),
  maxFiles: z.number().int().positive().optional(),
});

const jsonSchemaObjectSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), jsonSchemaPropertySchema),
  required: z.array(z.string()).optional(),
  propertyOrder: z.array(z.string()).optional(),
});

const serviceRequirementSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(SLUG_REGEX, "Doit etre un slug valide (a-z, 0-9, tirets, pas de tiret en debut/fin)"),
  provider: z.string(),
  scopes: z.array(z.string()).optional().default([]),
  connectionMode: z.enum(["user", "admin"]).optional().default("user"),
});

const slugString = z
  .string()
  .min(1)
  .regex(SLUG_REGEX, "Doit etre un slug valide (a-z, 0-9, tirets, pas de tiret en debut/fin)");

const manifestSchema = z.looseObject({
  $schema: z.string().optional(),
  schemaVersion: z.string(),
  metadata: z.object({
    id: slugString,
    displayName: z.string().min(1),
    description: z.string(),
    author: z.string(),
    license: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  requires: z.object({
    services: z.array(serviceRequirementSchema),
    skills: z.array(slugString).optional().default([]),
    extensions: z.array(slugString).optional().default([]),
  }),
  input: z
    .object({
      schema: jsonSchemaObjectSchema,
    })
    .optional(),
  output: z
    .object({
      schema: jsonSchemaObjectSchema,
    })
    .optional(),
  config: z
    .object({
      schema: jsonSchemaObjectSchema,
    })
    .optional(),
  execution: z
    .object({
      timeout: z.number().optional(),
      outputRetries: z.number().min(0).max(5).optional(),
    })
    .optional(),
});

// --- Section B: AJV runtime validation ---

const ajv = new Ajv({ coerceTypes: true, allErrors: true, strict: false });

function validateWithAjv(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) return { valid: true, errors: [], data };
  const errors = (validate.errors || []).map((e) => ({
    field:
      e.instancePath.replace(/^\//, "") ||
      (e.params as { missingProperty?: string })?.missingProperty ||
      "unknown",
    message: e.message || "Validation failed",
  }));
  return { valid: false, errors };
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
  schema: JSONSchemaObject,
): ValidationResult {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data };
  }
  return validateWithAjv(data, schema);
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data: input ?? {} };
  }
  // Exclude file fields from AJV validation (they're validated separately)
  const nonFileProps: Record<string, JSONSchemaProperty> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type !== "file") nonFileProps[key] = prop;
  }
  if (Object.keys(nonFileProps).length === 0) {
    return { valid: true, errors: [], data: input ?? {} };
  }
  const nonFileRequired = schema.required?.filter((k) => nonFileProps[k]) ?? [];
  const nonFileSchema: JSONSchemaObject = {
    type: "object",
    properties: nonFileProps,
    ...(nonFileRequired.length > 0 ? { required: nonFileRequired } : {}),
  };
  return validateWithAjv(input ?? {}, nonFileSchema);
}

export function validateFileInputs(
  files: UploadedFile[],
  schema: JSONSchemaObject,
): ValidationResult {
  const errors: { field: string; message: string }[] = [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type !== "file") continue;

    const fieldFiles = files.filter((f) => f.fieldName === key);
    const isRequired = schema.required?.includes(key);

    if (isRequired && fieldFiles.length === 0) {
      errors.push({ field: key, message: `Le fichier '${key}' est requis` });
      continue;
    }

    if (!prop.multiple && fieldFiles.length > 1) {
      errors.push({ field: key, message: `Le champ '${key}' n'accepte qu'un seul fichier` });
    }

    if (prop.maxFiles && fieldFiles.length > prop.maxFiles) {
      errors.push({
        field: key,
        message: `Le champ '${key}' accepte au maximum ${prop.maxFiles} fichiers`,
      });
    }

    // Validate each file
    const allowedExts = prop.accept
      ?.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    for (const file of fieldFiles) {
      if (prop.maxSize && file.size > prop.maxSize) {
        const maxMB = (prop.maxSize / (1024 * 1024)).toFixed(1);
        errors.push({
          field: key,
          message: `Le fichier '${file.name}' depasse la taille max (${maxMB} MB)`,
        });
      }

      if (allowedExts && allowedExts.length > 0) {
        const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
        if (!allowedExts.some((a) => a === ext)) {
          errors.push({
            field: key,
            message: `Le fichier '${file.name}' a une extension non autorisee (accepte: ${prop.accept})`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Check if a schema has any file fields */
export function schemaHasFileFields(schema?: JSONSchemaObject): boolean {
  if (!schema?.properties) return false;
  return Object.values(schema.properties).some((p) => p.type === "file");
}

/** Parse FormData to extract input JSON + uploaded files from a multipart request */
export async function parseFormDataFiles(
  formData: FormData,
  schema: JSONSchemaObject,
): Promise<{ input: Record<string, unknown>; files: UploadedFile[] }> {
  const inputRaw = formData.get("input");
  const input = typeof inputRaw === "string" && inputRaw ? JSON.parse(inputRaw) : {};

  const files: UploadedFile[] = [];
  const nameCounts = new Map<string, number>();
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type !== "file") continue;
    const entries = formData.getAll(key);
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      let fileName = entry.name;
      const count = nameCounts.get(fileName) ?? 0;
      if (count > 0) {
        const dotIdx = fileName.lastIndexOf(".");
        if (dotIdx > 0) {
          fileName = `${fileName.substring(0, dotIdx)}_${count}${fileName.substring(dotIdx)}`;
        } else {
          fileName = `${fileName}_${count}`;
        }
      }
      nameCounts.set(entry.name, count + 1);

      const buffer = Buffer.from(await entry.arrayBuffer());
      files.push({
        fieldName: key,
        name: fileName,
        type: entry.type,
        size: entry.size,
        buffer,
      });
    }
  }

  return { input, files };
}

export function validateOutput(
  result: Record<string, unknown>,
  schema: JSONSchemaObject,
): { valid: boolean; errors: string[] } {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [] };
  }
  // Use additionalProperties: true to allow extra fields (state, tokensUsed, etc.)
  const looseSchema: JSONSchemaObject & { additionalProperties: boolean } = {
    ...schema,
    additionalProperties: true,
  };
  const validate = ajv.compile(looseSchema);
  const valid = validate(result);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map(
    (e) =>
      `Field '${e.instancePath.replace(/^\//, "") || (e.params as { missingProperty?: string })?.missingProperty || "unknown"}': ${e.message || "Validation failed"}`,
  );
  return { valid: false, errors };
}

export function validateFlowContent(
  prompt: string,
  skills: { id: string; name?: string; description: string; content: string }[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!prompt || prompt.trim().length === 0) {
    errors.push("prompt ne peut pas etre vide");
  }
  const seenIds = new Set<string>();
  for (const skill of skills) {
    if (!SLUG_REGEX.test(skill.id)) {
      errors.push(`skill.id '${skill.id}' n'est pas un slug valide`);
    }
    if (seenIds.has(skill.id)) {
      errors.push(`skill.id '${skill.id}' est duplique`);
    }
    seenIds.add(skill.id);
  }
  return { valid: errors.length === 0, errors };
}
