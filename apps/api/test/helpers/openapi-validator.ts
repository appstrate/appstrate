// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI validator helper for integration tests.
 *
 * Given an assembled OpenAPI spec (with or without module contributions),
 * returns helpers to resolve schemas by path/method/status and validate
 * response bodies against them via AJV. Used by core and module tests alike.
 */
import Ajv from "ajv";

interface ValidationResult {
  valid: boolean;
  errors: string[];
  extraFields: string[];
  missingRequiredFields: string[];
}

export interface OpenApiValidator {
  getResponseSchema(path: string, method: string, statusCode: string): unknown;
  dereference(schema: unknown): unknown;
  validateResponse(body: unknown, schema: unknown): ValidationResult;
}

export function createOpenApiValidator(spec: unknown): OpenApiValidator {
  function resolveRef(ref: string): unknown {
    if (!ref.startsWith("#/")) throw new Error(`Unsupported $ref format: ${ref}`);
    const path = ref.slice(2).split("/");
    let current: unknown = spec;
    for (const segment of path) {
      if (typeof current !== "object" || current === null) {
        throw new Error(`Could not resolve $ref "${ref}" — missing segment "${segment}"`);
      }
      current = (current as Record<string, unknown>)[segment];
      if (current === undefined) {
        throw new Error(`Could not resolve $ref "${ref}" — missing segment "${segment}"`);
      }
    }
    return current;
  }

  function dereferenceSchema(schema: unknown, seen: Set<string> = new Set()): unknown {
    if (schema === null || schema === undefined) return schema;
    if (Array.isArray(schema)) {
      return schema.map((item) => dereferenceSchema(item, new Set(seen)));
    }
    if (typeof schema !== "object") return schema;

    const obj = schema as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const ref = obj.$ref;
      if (seen.has(ref)) return {};
      seen.add(ref);
      return dereferenceSchema(resolveRef(ref), new Set(seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = dereferenceSchema(value, new Set(seen));
    }
    return result;
  }

  function getResponseSchema(path: string, method: string, statusCode: string): unknown {
    const specObj = spec as { paths: Record<string, Record<string, unknown>> };
    const pathObj = specObj.paths[path];
    if (!pathObj) throw new Error(`Path "${path}" not found in OpenAPI spec`);

    const operation = pathObj[method.toLowerCase()] as Record<string, unknown> | undefined;
    if (!operation) throw new Error(`Method "${method}" not found for path "${path}"`);

    const responses = operation.responses as Record<string, unknown> | undefined;
    let responseObj = responses?.[statusCode] as Record<string, unknown> | undefined;
    if (!responseObj) throw new Error(`Status ${statusCode} not found for ${method} ${path}`);

    if (typeof responseObj.$ref === "string") {
      responseObj = resolveRef(responseObj.$ref) as Record<string, unknown>;
    }

    const content = responseObj.content as Record<string, { schema?: unknown }> | undefined;
    if (!content) return null;

    const mediaType = content["application/json"] ?? content["application/problem+json"];
    if (!mediaType?.schema) return null;

    return dereferenceSchema(mediaType.schema);
  }

  function createValidator(): Ajv {
    return new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
  }

  function validateResponse(body: unknown, schema: unknown): ValidationResult {
    const ajv = createValidator();
    const result: ValidationResult = {
      valid: true,
      errors: [],
      extraFields: [],
      missingRequiredFields: [],
    };

    const validate = ajv.compile(schema as object);
    const valid = validate(body);

    if (!valid && validate.errors) {
      result.valid = false;
      for (const err of validate.errors) {
        const path = err.instancePath || "(root)";
        result.errors.push(`${path}: ${err.message} (${err.keyword})`);
        if (err.keyword === "required") {
          const missing = (err.params as { missingProperty?: string }).missingProperty;
          if (missing) result.missingRequiredFields.push(`${path}/${missing}`);
        }
      }
    }

    const schemaObj = schema as { properties?: Record<string, unknown> };
    if (schemaObj.properties && typeof body === "object" && body !== null) {
      const schemaKeys = new Set(Object.keys(schemaObj.properties));
      const bodyKeys = Object.keys(body as Record<string, unknown>);
      for (const key of bodyKeys) {
        if (!schemaKeys.has(key)) {
          result.extraFields.push(key);
        }
      }
    }

    return result;
  }

  return {
    getResponseSchema,
    dereference: (schema: unknown) => dereferenceSchema(schema),
    validateResponse,
  };
}
