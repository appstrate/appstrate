/**
 * Request input parsing — parses input from FormData or JSON body.
 * Shared by executions.ts and share.ts.
 */

import type { Context } from "hono";
import type { UploadedFile } from "./adapters/types.ts";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import {
  validateInput,
  validateFileInputs,
  schemaHasFileFields,
  parseFormDataFiles,
} from "./schema.ts";

export interface ParsedInput {
  input?: Record<string, unknown>;
  uploadedFiles?: UploadedFile[];
}

export interface InputError {
  error: string;
  message: string;
  field?: string;
}

/**
 * Parse and validate request input from either FormData (if file fields) or JSON body.
 * Returns parsed input + uploaded files, or an error object.
 */
export async function parseRequestInput(
  c: Context,
  inputSchema?: JSONSchemaObject,
): Promise<{ ok: true; data: ParsedInput } | { ok: false; error: InputError; status: 400 }> {
  const hasFileFields = schemaHasFileFields(inputSchema);

  let body: { input?: Record<string, unknown> };
  let uploadedFiles: UploadedFile[] | undefined;

  if (hasFileFields) {
    try {
      const formData = await c.req.formData();
      const parsed = await parseFormDataFiles(formData, inputSchema!);
      body = { input: parsed.input };
      uploadedFiles = parsed.files;
    } catch (err) {
      return {
        ok: false,
        error: {
          error: "VALIDATION_ERROR",
          message: `FormData parsing error: ${err instanceof Error ? err.message : String(err)}`,
        },
        status: 400,
      };
    }

    if (uploadedFiles.length > 0) {
      const fileValidation = validateFileInputs(uploadedFiles, inputSchema!);
      if (!fileValidation.valid) {
        const first = fileValidation.errors[0]!;
        return {
          ok: false,
          error: { error: "VALIDATION_ERROR", message: first.message, field: first.field },
          status: 400,
        };
      }
    }
  } else {
    try {
      body = await c.req.json<{ input?: Record<string, unknown> }>();
    } catch {
      body = {};
    }
  }

  // Validate non-file input fields
  if (inputSchema) {
    const inputValidation = validateInput(body.input, inputSchema);
    if (!inputValidation.valid) {
      const first = inputValidation.errors[0]!;
      return {
        ok: false,
        error: { error: "INPUT_REQUIRED", message: first.message, field: first.field },
        status: 400,
      };
    }
  }

  return { ok: true, data: { input: body.input, uploadedFiles } };
}
