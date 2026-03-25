/**
 * Request input parsing — parses input from FormData or JSON body.
 * Shared by executions.ts.
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
import { invalidRequest } from "../lib/errors.ts";

export interface ParsedInput {
  input?: Record<string, unknown>;
  uploadedFiles?: UploadedFile[];
  modelId?: string;
  proxyId?: string;
}

/**
 * Parse and validate request input from either FormData (if file fields) or JSON body.
 * Returns parsed input + uploaded files. Throws ApiError on validation failure.
 */
export async function parseRequestInput(
  c: Context,
  inputSchema?: JSONSchemaObject,
): Promise<ParsedInput> {
  const hasFileFields = schemaHasFileFields(inputSchema);

  let body: { input?: Record<string, unknown>; modelId?: string; proxyId?: string };
  let uploadedFiles: UploadedFile[] | undefined;

  if (hasFileFields) {
    try {
      const formData = await c.req.formData();
      const parsed = await parseFormDataFiles(formData, inputSchema!);
      body = { input: parsed.input };
      uploadedFiles = parsed.files;
    } catch (err) {
      throw invalidRequest(
        `FormData parsing error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Always validate file inputs — catches missing required files even when none uploaded
    const fileValidation = validateFileInputs(uploadedFiles, inputSchema!);
    if (!fileValidation.valid) {
      const first = fileValidation.errors[0]!;
      throw invalidRequest(first.message, first.field);
    }
  } else {
    try {
      body = await c.req.json<{
        input?: Record<string, unknown>;
        modelId?: string;
        proxyId?: string;
      }>();
    } catch {
      body = {};
    }
  }

  // Validate non-file input fields
  if (inputSchema) {
    const inputValidation = validateInput(body.input, inputSchema);
    if (!inputValidation.valid) {
      const first = inputValidation.errors[0]!;
      throw invalidRequest(first.message, first.field);
    }
  }

  return { input: body.input, uploadedFiles, modelId: body.modelId, proxyId: body.proxyId };
}
