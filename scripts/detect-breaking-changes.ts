// SPDX-License-Identifier: Apache-2.0

/**
 * Detect breaking changes in the OpenAPI spec by comparing against a baseline.
 *
 * Breaking changes (exit code 1):
 *   - Removed endpoints (path+method gone)
 *   - Removed response fields (property removed from response schema)
 *   - Added required fields to request bodies
 *   - Changed field types (string → number, etc.)
 *   - Removed enum values
 *   - Changed response status codes (removed status code)
 *
 * Non-breaking changes (info only):
 *   - New endpoints
 *   - New optional request/response fields
 *   - New enum values
 *   - New response status codes
 *
 * Usage:
 *   bun scripts/detect-breaking-changes.ts                  # Compare against baseline
 *   bun scripts/detect-breaking-changes.ts --update-baseline # Save current spec as baseline
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { buildOpenApiSpec } from "../apps/api/src/openapi/index.ts";
import type { AppstrateModule } from "@appstrate/core/module";

const BASELINE_PATH = resolve(import.meta.dir, "../apps/api/src/openapi/baseline.json");

// ═══════════════════════════════════════════════════
// Auto-discover built-in modules and collect their OpenAPI contributions
// ═══════════════════════════════════════════════════
// Mirrors the discovery block in scripts/verify-openapi.ts — we cannot boot
// the module loader here, so we scan apps/api/src/modules/*/index.ts directly
// and call each module's openApiPaths()/openApiComponentSchemas() statically.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modulesDir = resolve(scriptDir, "../apps/api/src/modules");
const discoveredModules: string[] = existsSync(modulesDir)
  ? readdirSync(modulesDir).filter((name) => {
      const subdir = join(modulesDir, name);
      try {
        return statSync(subdir).isDirectory() && existsSync(join(subdir, "index.ts"));
      } catch {
        return false;
      }
    })
  : [];

const modulePaths: Record<string, unknown> = {};
const moduleComponentSchemas: Record<string, unknown> = {};

for (const name of discoveredModules) {
  const mod: AppstrateModule = (await import(join(modulesDir, name, "index.ts"))).default;
  const paths = mod.openApiPaths?.();
  if (paths) Object.assign(modulePaths, paths);
  const compSchemas = mod.openApiComponentSchemas?.();
  if (compSchemas) Object.assign(moduleComponentSchemas, compSchemas);
}

const openApiSpec = buildOpenApiSpec(modulePaths, moduleComponentSchemas);

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

interface Change {
  level: "breaking" | "info";
  message: string;
}

type Spec = Record<string, unknown>;
type PathsObj = Record<string, Record<string, unknown>>;

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

/** Resolve a JSON Pointer ($ref like "#/components/schemas/Foo") against a spec. */
function resolveRef(ref: string, spec: Spec): Spec | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as Spec | undefined;
}

/** Dereference a schema — if it has $ref, resolve it. */
function deref(schema: Spec | undefined, spec: Spec): Spec | undefined {
  if (!schema) return undefined;
  if (typeof schema.$ref === "string") return resolveRef(schema.$ref, spec);
  return schema;
}

/** Extract a flat type string from a schema for comparison. */
function extractType(schema: Spec | undefined, spec: Spec): string {
  if (!schema) return "unknown";
  const s = deref(schema, spec);
  if (!s) return "unknown";

  if (typeof s.type === "string") return s.type;
  if (Array.isArray(s.type))
    return (s.type as string[])
      .filter((t) => t !== "null")
      .sort()
      .join("|");
  if (Array.isArray(s.anyOf)) {
    const types = (s.anyOf as Spec[])
      .map((v) => (typeof v.type === "string" ? v.type : ""))
      .filter((t) => t && t !== "null")
      .sort();
    return types.join("|") || "unknown";
  }
  if (Array.isArray(s.oneOf)) return "oneOf";
  if (s.allOf) return "allOf";
  return "unknown";
}

/** Get enum values from a schema as a sorted string set. */
function extractEnum(schema: Spec | undefined, spec: Spec): string[] | null {
  if (!schema) return null;
  const s = deref(schema, spec);
  if (!s) return null;
  if (Array.isArray(s.enum)) return [...(s.enum as string[])].map(String).sort();
  return null;
}

/** Get properties from a schema (resolving $ref). */
function getProperties(schema: Spec | undefined, spec: Spec): Record<string, Spec> {
  if (!schema) return {};
  const s = deref(schema, spec);
  if (!s || typeof s.properties !== "object" || s.properties === null) return {};
  return s.properties as Record<string, Spec>;
}

/** Get required fields from a schema. */
function getRequired(schema: Spec | undefined, spec: Spec): Set<string> {
  if (!schema) return new Set();
  const s = deref(schema, spec);
  if (!s || !Array.isArray(s.required)) return new Set();
  return new Set(s.required as string[]);
}

/** Get the request body schema for an operation. */
function getRequestBodySchema(operation: Spec, spec: Spec): Spec | undefined {
  const rb = operation.requestBody as Spec | undefined;
  if (!rb) return undefined;
  const content = rb.content as Record<string, Spec> | undefined;
  if (!content) return undefined;
  const json = content["application/json"];
  if (!json) return undefined;
  return deref(json.schema as Spec | undefined, spec);
}

/** Get response schemas keyed by status code. */
function getResponses(operation: Spec): Record<string, Spec> {
  if (!operation.responses || typeof operation.responses !== "object") return {};
  return operation.responses as Record<string, Spec>;
}

/** Get the response body schema for a given response object. */
function getResponseBodySchema(response: Spec, spec: Spec): Spec | undefined {
  const content = response.content as Record<string, Spec> | undefined;
  if (!content) return undefined;
  const json = content["application/json"];
  if (!json) return undefined;
  return deref(json.schema as Spec | undefined, spec);
}

// ═══════════════════════════════════════════════════
// Comparison engine
// ═══════════════════════════════════════════════════

function compareSpecs(baseline: Spec, current: Spec): Change[] {
  const changes: Change[] = [];

  const baselinePaths = (baseline.paths || {}) as PathsObj;
  const currentPaths = (current.paths || {}) as PathsObj;

  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];

  // 1. Check each baseline endpoint
  for (const [path, baselineMethods] of Object.entries(baselinePaths)) {
    const currentMethods = currentPaths[path];

    for (const method of HTTP_METHODS) {
      const baselineOp = baselineMethods[method] as Spec | undefined;
      if (!baselineOp) continue;

      const label = `${method.toUpperCase()} ${path}`;

      // Endpoint removed?
      if (!currentMethods || !currentMethods[method]) {
        changes.push({ level: "breaking", message: `Endpoint removed: ${label}` });
        continue;
      }

      const currentOp = currentMethods[method] as Spec;

      // Compare request body
      const baseReqSchema = getRequestBodySchema(baselineOp, baseline);
      const currReqSchema = getRequestBodySchema(currentOp, current);

      if (baseReqSchema && currReqSchema) {
        // New required fields in request body = breaking
        const baseRequired = getRequired(baseReqSchema, baseline);
        const currRequired = getRequired(currReqSchema, current);
        for (const field of currRequired) {
          if (!baseRequired.has(field)) {
            // Only breaking if the field didn't exist before (truly new required field)
            const baseProps = getProperties(baseReqSchema, baseline);
            if (!baseProps[field]) {
              changes.push({
                level: "breaking",
                message: `${label}: new required request field "${field}" added`,
              });
            } else {
              // Field existed but was optional, now required = breaking
              changes.push({
                level: "breaking",
                message: `${label}: request field "${field}" changed from optional to required`,
              });
            }
          }
        }

        // Compare property types in request body
        const baseProps = getProperties(baseReqSchema, baseline);
        const currProps = getProperties(currReqSchema, current);

        for (const [field, baseProp] of Object.entries(baseProps)) {
          const currProp = currProps[field];
          if (!currProp) continue; // Removing request fields is non-breaking (less strict)

          const baseType = extractType(baseProp, baseline);
          const currType = extractType(currProp, current);
          if (baseType !== currType && baseType !== "unknown" && currType !== "unknown") {
            changes.push({
              level: "breaking",
              message: `${label}: request field "${field}" type changed: ${baseType} -> ${currType}`,
            });
          }

          // Enum values removed in request
          const baseEnum = extractEnum(baseProp, baseline);
          const currEnum = extractEnum(currProp, current);
          if (baseEnum && currEnum) {
            const removed = baseEnum.filter((v) => !currEnum.includes(v));
            if (removed.length > 0) {
              changes.push({
                level: "breaking",
                message: `${label}: request field "${field}" enum values removed: ${removed.join(", ")}`,
              });
            }
            const added = currEnum.filter((v) => !baseEnum.includes(v));
            if (added.length > 0) {
              changes.push({
                level: "info",
                message: `${label}: request field "${field}" enum values added: ${added.join(", ")}`,
              });
            }
          }
        }

        // New optional request fields = info
        for (const field of Object.keys(currProps)) {
          if (!baseProps[field] && !currRequired.has(field)) {
            changes.push({
              level: "info",
              message: `${label}: new optional request field "${field}" added`,
            });
          }
        }
      }

      // Compare response status codes and schemas
      const baseResponses = getResponses(baselineOp);
      const currResponses = getResponses(currentOp);

      for (const statusCode of Object.keys(baseResponses)) {
        if (!currResponses[statusCode]) {
          changes.push({
            level: "breaking",
            message: `${label}: response status code ${statusCode} removed`,
          });
          continue;
        }

        // Compare response body properties
        const baseRespSchema = getResponseBodySchema(baseResponses[statusCode] as Spec, baseline);
        const currRespSchema = getResponseBodySchema(currResponses[statusCode] as Spec, current);

        if (baseRespSchema && currRespSchema) {
          const baseProps = getProperties(baseRespSchema, baseline);
          const currProps = getProperties(currRespSchema, current);

          for (const [field, baseProp] of Object.entries(baseProps)) {
            if (!currProps[field]) {
              changes.push({
                level: "breaking",
                message: `${label}: response field "${field}" removed from ${statusCode} response`,
              });
              continue;
            }

            const baseType = extractType(baseProp, baseline);
            const currType = extractType(currProps[field], current);
            if (baseType !== currType && baseType !== "unknown" && currType !== "unknown") {
              changes.push({
                level: "breaking",
                message: `${label}: response field "${field}" type changed in ${statusCode}: ${baseType} -> ${currType}`,
              });
            }

            // Enum values removed in response
            const baseEnum = extractEnum(baseProp, baseline);
            const currEnum = extractEnum(currProps[field], current);
            if (baseEnum && currEnum) {
              const removed = baseEnum.filter((v) => !currEnum.includes(v));
              if (removed.length > 0) {
                changes.push({
                  level: "breaking",
                  message: `${label}: response field "${field}" enum values removed in ${statusCode}: ${removed.join(", ")}`,
                });
              }
            }
          }

          // New response fields = info
          for (const field of Object.keys(currProps)) {
            if (!baseProps[field]) {
              changes.push({
                level: "info",
                message: `${label}: new response field "${field}" added to ${statusCode} response`,
              });
            }
          }
        }
      }

      // New response status codes = info
      for (const statusCode of Object.keys(currResponses)) {
        if (!baseResponses[statusCode]) {
          changes.push({
            level: "info",
            message: `${label}: new response status code ${statusCode} added`,
          });
        }
      }
    }
  }

  // 2. New endpoints = info
  for (const [path, currentMethods] of Object.entries(currentPaths)) {
    const baselineMethods = baselinePaths[path];

    for (const method of HTTP_METHODS) {
      if (!(currentMethods as Record<string, unknown>)[method]) continue;

      if (!baselineMethods || !(baselineMethods as Record<string, unknown>)[method]) {
        changes.push({
          level: "info",
          message: `New endpoint: ${method.toUpperCase()} ${path}`,
        });
      }
    }
  }

  return changes;
}

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════

const updateBaseline = process.argv.includes("--update-baseline");
const currentSpec = JSON.parse(JSON.stringify(openApiSpec));

if (updateBaseline) {
  await Bun.write(BASELINE_PATH, JSON.stringify(currentSpec, null, 2) + "\n");
  console.log(`\n  Baseline updated: ${BASELINE_PATH}`);
  console.log(
    `  Endpoints: ${Object.entries(currentSpec.paths || {}).reduce((n: number, [, m]) => n + Object.keys(m as object).length, 0)}`,
  );
  console.log();
  process.exit(0);
}

// Read baseline
const baselineFile = Bun.file(BASELINE_PATH);
if (!(await baselineFile.exists())) {
  console.error(`\n  No baseline found at ${BASELINE_PATH}`);
  console.error(`  Run with --update-baseline to create one.\n`);
  process.exit(1);
}

const baseline = JSON.parse(await baselineFile.text());
const changes = compareSpecs(baseline, currentSpec);

const breaking = changes.filter((c) => c.level === "breaking");
const info = changes.filter((c) => c.level === "info");

console.log(`\n  OpenAPI Breaking Change Detection`);
console.log(`  ${"=".repeat(40)}`);

if (breaking.length > 0) {
  console.log(`\n  BREAKING CHANGES (${breaking.length}):\n`);
  for (const c of breaking) {
    console.log(`  ERROR  ${c.message}`);
  }
}

if (info.length > 0) {
  console.log(`\n  Non-breaking changes (${info.length}):\n`);
  for (const c of info) {
    console.log(`  INFO   ${c.message}`);
  }
}

if (breaking.length === 0 && info.length === 0) {
  console.log(`\n  No changes detected against baseline.`);
}

console.log(`\n  ${"=".repeat(40)}`);
console.log(
  `  ${breaking.length === 0 ? "PASSED" : "FAILED"} — ${breaking.length} breaking, ${info.length} non-breaking`,
);
console.log(`  ${"=".repeat(40)}\n`);

process.exit(breaking.length > 0 ? 1 : 0);
