// SPDX-License-Identifier: Apache-2.0

import Ajv from "ajv";
import {
  isFileField,
  type JSONSchemaObject,
  type JSONSchema7,
  type FileConstraint,
} from "@appstrate/core/form";
import type { UploadedFile } from "./adapters/types.ts";
import { scopedNameRegex } from "@appstrate/core/validation";
import { normalizeConfigForValidation } from "../lib/agent-readiness-utils.ts";

// --- AJV runtime validation ---

const ajv = new Ajv({ coerceTypes: true, allErrors: true, strict: false });

// --- Section C: Validation functions ---

export interface ValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
  data?: Record<string, unknown>;
}

/**
 * Shared AJV validation path for config/input/output.
 *
 * Differences between the three kinds, encoded here:
 * - "config":  validates the raw schema, normalizes empty strings as missing for required fields.
 * - "input":   filters out file fields (validated separately), normalizes empty strings for the
 *              remaining required fields. Accepts `undefined` input (defaults to `{}`).
 * - "output":  relaxes `additionalProperties: true` (extra fields like state/tokenUsage allowed),
 *              skips normalization, and returns errors as pre-formatted strings (different return
 *              shape from config/input).
 */
function runValidate(
  kind: "config",
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult;
function runValidate(
  kind: "input",
  data: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult;
function runValidate(
  kind: "output",
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): { valid: boolean; errors: string[] };
function runValidate(
  kind: "config" | "input" | "output",
  data: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult | { valid: boolean; errors: string[] } {
  // 1. Empty-schema short circuit
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    if (kind === "output") return { valid: true, errors: [] };
    return {
      valid: true,
      errors: [],
      data: kind === "input" ? (data ?? {}) : data,
    };
  }

  // 2. Per-kind schema + data preparation
  let effectiveSchema: JSONSchemaObject = schema;
  let effectiveData: Record<string, unknown> = data ?? {};

  if (kind === "config") {
    // Treat empty strings as missing for required fields (aligned with frontend validation)
    effectiveData = normalizeConfigForValidation(effectiveData, schema.required ?? []);
  } else if (kind === "input") {
    // Exclude file fields from AJV validation (they're validated separately)
    const nonFileProps: Record<string, JSONSchema7> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (!isFileField(prop)) nonFileProps[key] = prop;
    }
    if (Object.keys(nonFileProps).length === 0) {
      return { valid: true, errors: [], data: effectiveData };
    }
    const nonFileRequired = schema.required?.filter((k) => nonFileProps[k]) ?? [];
    effectiveSchema = {
      type: "object",
      properties: nonFileProps,
      ...(nonFileRequired.length > 0 ? { required: nonFileRequired } : {}),
    };
    // Treat empty strings as missing for required fields (aligned with config validation)
    effectiveData = normalizeConfigForValidation(effectiveData, nonFileRequired);
  } else {
    // output: allow extra fields (state, tokenUsage, etc.)
    effectiveSchema = { ...schema, additionalProperties: true } as JSONSchemaObject & {
      additionalProperties: boolean;
    };
  }

  // 3. Compile + validate
  const validate = ajv.compile(effectiveSchema);
  const valid = validate(effectiveData);

  // 4. Per-kind error mapping
  if (kind === "output") {
    if (valid) return { valid: true, errors: [] };
    const errors = (validate.errors || []).map(
      (e) =>
        `Field '${e.instancePath.replace(/^\//, "") || (e.params as { missingProperty?: string })?.missingProperty || "unknown"}': ${e.message || "Validation failed"}`,
    );
    return { valid: false, errors };
  }

  if (valid) return { valid: true, errors: [], data: effectiveData };
  const errors = (validate.errors || []).map((e) => ({
    field:
      e.instancePath.replace(/^\//, "") ||
      (e.params as { missingProperty?: string })?.missingProperty ||
      "unknown",
    message: e.message || "Validation failed",
  }));
  return { valid: false, errors };
}

export function validateConfig(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult {
  return runValidate("config", data, schema);
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult {
  return runValidate("input", input, schema);
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
  return runValidate("output", result, schema);
}

export function validateAgentContent(
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
