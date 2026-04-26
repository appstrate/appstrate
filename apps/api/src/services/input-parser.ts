// SPDX-License-Identifier: Apache-2.0

/**
 * Request input parsing.
 *
 * The request body is always JSON. File fields carry `upload://upl_xxx` URIs
 * that point to previously staged uploads. Each URI is resolved into a
 * `UploadedFile` (buffer + metadata) via the uploads service, which also
 * performs magic-byte MIME validation and marks the upload as consumed.
 */

import type { Context } from "hono";
import type { UploadedFile } from "./adapters/types.ts";
import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";
import { validateInput } from "./schema.ts";
import { invalidRequest, validationFailed } from "../lib/errors.ts";
import { consumeUpload, isUploadUri, parseUploadUri } from "./uploads.ts";

export interface ParsedInput {
  input?: Record<string, unknown>;
  uploadedFiles?: UploadedFile[];
  modelId?: string;
  proxyId?: string;
  /**
   * Per-run config override. Deep-merged with `application_packages.config`
   * before the run is executed (see `deepMergeConfig` in
   * `@appstrate/core/schema-validation`). Mirrors the OpenAI Assistants
   * `runs.create { instructions, model, tools }` and Argo Workflows
   * `submitOptions.parameters` SOTA: the merge happens server-side so
   * UI / CLI / SDK clients all reach the same resolved config for the
   * same `(persisted, override)` pair.
   */
  configOverride?: Record<string, unknown>;
}

interface RunRequestBody {
  input?: Record<string, unknown>;
  modelId?: string;
  proxyId?: string;
  config?: Record<string, unknown>;
}

function getArrayItems(prop: JSONSchema7): JSONSchema7 | undefined {
  if (!prop.items || typeof prop.items === "boolean") return undefined;
  if (Array.isArray(prop.items)) {
    const first = prop.items[0];
    return typeof first === "object" ? first : undefined;
  }
  return prop.items;
}

/**
 * Walk the schema, find file-shaped properties, and validate that each
 * matching input value is an `upload://` URI (or an array of them). Pure —
 * exported for unit tests, has no I/O.
 */
export function collectUploadRefs(
  schema: JSONSchemaObject,
  input: Record<string, unknown>,
): { fieldName: string; uri: string }[] {
  const refs: { fieldName: string; uri: string }[] = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!isFileField(prop)) continue;
    const value = input[key];
    if (value == null) continue;
    const isArrayField = prop.type === "array" || !!getArrayItems(prop);
    if (isArrayField) {
      if (!Array.isArray(value)) {
        throw invalidRequest(`Field '${key}' expected an array of upload URIs`, key);
      }
      for (const v of value) {
        if (!isUploadUri(v)) {
          throw invalidRequest(`Field '${key}' entries must be 'upload://<id>' URIs`, key);
        }
        refs.push({ fieldName: key, uri: v });
      }
    } else {
      if (!isUploadUri(value)) {
        throw invalidRequest(`Field '${key}' must be an 'upload://<id>' URI`, key);
      }
      refs.push({ fieldName: key, uri: value });
    }
  }
  return refs;
}

/**
 * Parse and validate the run request body. Returns parsed input + resolved
 * uploaded files. Throws `ApiError` (invalidRequest / notFound) on any
 * validation or resolution failure.
 */
export async function parseRequestInput(
  c: Context,
  inputSchema?: JSONSchemaObject,
): Promise<ParsedInput> {
  let body: RunRequestBody = {};
  try {
    const raw = await c.req.json<RunRequestBody>();
    if (raw && typeof raw === "object") body = raw;
  } catch {
    body = {};
  }
  const input = body.input ?? {};
  let uploadedFiles: UploadedFile[] = [];

  if (inputSchema) {
    const refs = collectUploadRefs(inputSchema, input);
    const orgId = c.get("orgId");
    const applicationId = c.get("applicationId");
    // Resolve all upload references in parallel — each `consumeUpload` is an
    // independent atomic claim. For multi-file forms this cuts wall-time from
    // O(N * roundtrip) to O(roundtrip).
    uploadedFiles = await Promise.all(
      refs.map(async (ref) => {
        const id = parseUploadUri(ref.uri);
        if (!id) throw invalidRequest(`Invalid upload URI '${ref.uri}'`, ref.fieldName);
        const consumed = await consumeUpload(id, { orgId, applicationId });
        return {
          fieldName: ref.fieldName,
          name: consumed.name,
          type: consumed.mime,
          size: consumed.size,
          buffer: consumed.buffer,
        };
      }),
    );

    const inputValidation = validateInput(input, inputSchema);
    if (!inputValidation.valid) {
      throw validationFailed(
        inputValidation.errors.map((e) => ({
          field: e.field ? `input.${e.field}` : "input",
          code: "invalid_input",
          title: "Invalid Input",
          message: e.message,
        })),
      );
    }
  }

  // `config` in the body is a partial override that is *deep-merged* with
  // `application_packages.config` by the run route. We pass it through as
  // an opaque object — validation against the manifest schema runs after
  // the merge so a client can omit keys the persisted state already
  // satisfies.
  if (
    body.config !== undefined &&
    (typeof body.config !== "object" || Array.isArray(body.config))
  ) {
    throw invalidRequest("`config` must be a JSON object", "config");
  }

  return {
    input,
    uploadedFiles: uploadedFiles.length > 0 ? uploadedFiles : undefined,
    modelId: body.modelId,
    proxyId: body.proxyId,
    configOverride: body.config,
  };
}
