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
      // External refs (e.g. the AFPS `https://schemas.afps.dev/...` manifest
      // schema) can't be resolved in-process — treat as permissive `{}` so
      // validation covers the response envelope without fetching the network
      // schema. Same fallback as the circular-ref guard below.
      if (!ref.startsWith("#/")) return {};
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

  /**
   * Deep-clone a (dereferenced) schema, injecting `additionalProperties: false`
   * on every PURE object node — one that declares `properties` but is neither a
   * composed node (`allOf`/`oneOf`/`anyOf`, where `additionalProperties` is a
   * JSON-Schema footgun) nor already opted open (`additionalProperties: true`,
   * or a schema-valued `additionalProperties` map). This turns AJV into a
   * full-depth undeclared-field detector: an extra field inside a `data[]` list
   * item or any nested object is flagged, not just at the root.
   *
   * Strict-by-default: a response field the SPA's generated type can't see is
   * drift. Genuinely dynamic bodies (RFC 7662 introspection claims, JSONB) opt
   * out with `additionalProperties: true` and stay open at that node.
   */
  function closeSchema(node: unknown, inComposition = false): unknown {
    if (Array.isArray(node)) return node.map((n) => closeSchema(n));
    if (node === null || typeof node !== "object") return node;

    const obj = node as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "properties" && v && typeof v === "object") {
        const props: Record<string, unknown> = {};
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          props[pk] = closeSchema(pv);
        }
        clone[k] = props;
      } else if (k === "items" || k === "additionalProperties") {
        clone[k] = closeSchema(v);
      } else if (k === "allOf" || k === "oneOf" || k === "anyOf") {
        // Members of a composition keyword must NOT get additionalProperties:
        // false — within an allOf, a closed branch rejects sibling branches'
        // fields (the classic JSON-Schema footgun). Recurse, but flag them.
        clone[k] = Array.isArray(v) ? v.map((m) => closeSchema(m, true)) : closeSchema(v, true);
      } else {
        clone[k] = v;
      }
    }

    const composed = "allOf" in clone || "oneOf" in clone || "anyOf" in clone;
    if (
      !inComposition &&
      clone.properties &&
      !composed &&
      clone.additionalProperties === undefined
    ) {
      clone.additionalProperties = false;
    }
    return clone;
  }

  function validateResponse(body: unknown, schema: unknown): ValidationResult {
    const ajv = createValidator();
    const result: ValidationResult = {
      valid: true,
      errors: [],
      extraFields: [],
      missingRequiredFields: [],
    };

    const validate = ajv.compile(closeSchema(schema) as object);
    const valid = validate(body);

    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        const path = err.instancePath || "(root)";
        if (err.keyword === "additionalProperties") {
          // Undeclared field at any depth — tracked separately so callers can
          // distinguish "extra field" drift from a hard schema violation.
          const extra = (err.params as { additionalProperty?: string }).additionalProperty;
          result.extraFields.push(`${path}/${extra ?? "?"}`);
          continue;
        }
        result.errors.push(`${path}: ${err.message} (${err.keyword})`);
        if (err.keyword === "required") {
          const missing = (err.params as { missingProperty?: string }).missingProperty;
          if (missing) result.missingRequiredFields.push(`${path}/${missing}`);
        }
      }
    }

    result.valid = result.errors.length === 0;
    return result;
  }

  return {
    getResponseSchema,
    dereference: (schema: unknown) => dereferenceSchema(schema),
    validateResponse,
  };
}
