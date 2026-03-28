import Ajv from "ajv";
import type { JSONSchemaObject, JSONSchema7, FileConstraint } from "@appstrate/shared-types";
import { isFileField } from "@appstrate/shared-types";
import type { UploadedFile } from "./adapters/types.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { normalizeConfigForValidation } from "../lib/flow-readiness.ts";

// --- AJV runtime validation ---

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

export function validateConfig(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data };
  }
  // Treat empty strings as missing for required fields (aligned with frontend validation)
  const cleaned = normalizeConfigForValidation(data, schema.required ?? []);
  return validateWithAjv(cleaned, schema);
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data: input ?? {} };
  }
  // Exclude file fields from AJV validation (they're validated separately)
  const nonFileProps: Record<string, JSONSchema7> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!isFileField(prop)) nonFileProps[key] = prop;
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
  // Treat empty strings as missing for required fields (aligned with config validation)
  const cleaned = normalizeConfigForValidation(input ?? {}, nonFileRequired);
  return validateWithAjv(cleaned, nonFileSchema);
}

export function validateFileInputs(
  files: UploadedFile[],
  schema: JSONSchemaObject,
  fileConstraints?: Record<string, FileConstraint>,
): ValidationResult {
  const errors: { field: string; message: string }[] = [];

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!isFileField(prop)) continue;

    const fieldFiles = files.filter((f) => f.fieldName === key);
    const isRequired = schema.required?.includes(key);

    if (isRequired && fieldFiles.length === 0) {
      errors.push({ field: key, message: `File '${key}' is required` });
      continue;
    }

    const multiple = prop.type === "array";
    if (!multiple && fieldFiles.length > 1) {
      errors.push({ field: key, message: `Field '${key}' accepts only one file` });
    }

    const maxFiles = prop.maxItems;
    if (maxFiles && fieldFiles.length > maxFiles) {
      errors.push({
        field: key,
        message: `Field '${key}' accepts at most ${maxFiles} files`,
      });
    }

    // Read upload constraints from wrapper-level fileConstraints
    const constraints = fileConstraints?.[key];
    const allowedExts = constraints?.accept
      ?.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    for (const file of fieldFiles) {
      if (constraints?.maxSize && file.size > constraints.maxSize) {
        const maxMB = (constraints.maxSize / (1024 * 1024)).toFixed(1);
        errors.push({
          field: key,
          message: `File '${file.name}' exceeds max size (${maxMB} MB)`,
        });
      }

      if (allowedExts && allowedExts.length > 0) {
        const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
        if (!allowedExts.some((a) => a === ext)) {
          errors.push({
            field: key,
            message: `File '${file.name}' has a disallowed extension (accepted: ${constraints?.accept})`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Check if a schema has any file fields (format: "uri" + contentMediaType). */
export function schemaHasFileFields(schema?: JSONSchemaObject): boolean {
  if (!schema?.properties) return false;
  return Object.values(schema.properties).some(isFileField);
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
    if (!isFileField(prop)) continue;
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
    errors.push("prompt cannot be empty");
  }
  const seenIds = new Set<string>();
  for (const skill of skills) {
    if (!scopedNameRegex.test(skill.id)) {
      errors.push(`skill.id '${skill.id}' is not a valid package reference`);
    }
    if (seenIds.has(skill.id)) {
      errors.push(`skill.id '${skill.id}' is duplicated`);
    }
    seenIds.add(skill.id);
  }
  return { valid: errors.length === 0, errors };
}
