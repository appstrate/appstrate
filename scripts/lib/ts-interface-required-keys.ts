// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the recursive {@link TypeShape} of an exported type from
 * `@appstrate/shared-types`, using the TypeScript Compiler API.
 *
 * Used by verify-openapi step #7 to compare a shared-type's required fields —
 * at every nesting level — against the OpenAPI response schema that mirrors it.
 *
 * `getPropertiesOfType` flattens `extends` / intersection types, so a type like
 * `EnrichedRun = RunWireDto & {…}` reports the full merged property set. A
 * property is treated as required iff it does NOT carry the `Optional` symbol
 * flag (i.e. it is not declared with `?`).
 */
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import ts from "typescript";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO_ROOT, "packages/shared-types/src/index.ts");

/**
 * Read compilerOptions from the nearest tsconfig (shared-types extends the
 * base config), falling back to sensible strict defaults when parsing fails.
 */
function loadCompilerOptions(): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    strict: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
  };

  const tsconfigPath = join(REPO_ROOT, "packages/shared-types/tsconfig.json");
  if (!existsSync(tsconfigPath)) return defaults;

  const read = ts.readConfigFile(tsconfigPath, (p) => readFileSync(p, "utf8"));
  if (read.error || !read.config) return defaults;

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    join(REPO_ROOT, "packages/shared-types"),
  );
  if (parsed.errors.length > 0) return defaults;

  return { ...parsed.options, noEmit: true };
}

let cachedProgram: ts.Program | undefined;
let cachedChecker: ts.TypeChecker | undefined;
let cachedSource: ts.SourceFile | undefined;

function getProgram(): {
  checker: ts.TypeChecker;
  source: ts.SourceFile;
} {
  if (cachedProgram && cachedChecker && cachedSource) {
    return { checker: cachedChecker, source: cachedSource };
  }
  cachedProgram = ts.createProgram([ENTRY], loadCompilerOptions());
  cachedChecker = cachedProgram.getTypeChecker();
  const source = cachedProgram.getSourceFile(ENTRY);
  if (!source) {
    throw new Error(`ts-interface-required-keys: could not load source file ${ENTRY}`);
  }
  cachedSource = source;
  return { checker: cachedChecker, source };
}

/**
 * Recursive shape of a shared-type, used by verify-openapi step #7 to compare
 * required fields at every nesting level. `nested` maps a property name to the
 * shape of its value type when that type is a closed object — or, for an array
 * property, the shape of its element type. Properties whose type is a primitive,
 * a union, a `Record` (index signature), `Date`, or an otherwise-open type are
 * absent from `nested` (not comparable structurally).
 */
export interface TypeShape {
  required: Set<string>;
  nested: Map<string, TypeShape>;
}

/** Strip `null` / `undefined` from a union; return the single remaining type, or null if 0 or >1 remain. */
function stripNullish(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  if (!type.isUnion()) return type;
  const rest = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  return rest.length === 1 ? rest[0]! : null;
}

/** A type we can descend into for structural required-field comparison (a closed object, not a Record/Date/array). */
function closedObjectType(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const core = stripNullish(checker, type);
  if (!core) return null;
  // Object OR intersection-of-objects (e.g. `SchemaWrapper & { current }`).
  // getPropertiesOfType flattens intersections, so both are descendable.
  if (!(core.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return null;
  const name = core.getSymbol()?.getName();
  if (name === "Date" || name === "Array" || name === "ReadonlyArray") return null;
  // A string index signature means it's a map (Record<string, X>) — not a fixed shape.
  if (checker.getIndexInfoOfType(core, ts.IndexKind.String)) return null;
  if (core.getProperties().length === 0) return null;
  return core;
}

/** If `type` is an array/readonly-array, return its element type; else null. */
function arrayElementType(checker: ts.TypeChecker, type: ts.Type): ts.Type | null {
  const core = stripNullish(checker, type);
  if (!core) return null;
  const name = core.getSymbol()?.getName();
  if (name !== "Array" && name !== "ReadonlyArray") return null;
  const args = checker.getTypeArguments(core as ts.TypeReference);
  return args.length === 1 ? args[0]! : null;
}

function buildShape(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  seen: Set<ts.Type>,
): TypeShape {
  const required = new Set<string>();
  const nested = new Map<string, TypeShape>();
  if (depth > 8 || seen.has(type)) return { required, nested };
  seen.add(type);

  for (const prop of checker.getPropertiesOfType(type)) {
    const name = prop.getName();
    const optional = !!(prop.flags & ts.SymbolFlags.Optional);
    if (!optional) required.add(name);

    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);

    // Array-of-object → descend into element shape; closed object → descend.
    const elem = arrayElementType(checker, propType);
    const target = elem ? closedObjectType(checker, elem) : closedObjectType(checker, propType);
    if (target) nested.set(name, buildShape(checker, target, depth + 1, seen));
  }
  seen.delete(type);
  return { required, nested };
}

/**
 * Return the recursive {@link TypeShape} of an exported shared-type. Throws if
 * the type is not an exported member of `@appstrate/shared-types`.
 */
export function getTypeShape(typeName: string): TypeShape {
  const { checker } = getProgram();
  const type = resolveExportedType(checker, typeName);
  return buildShape(checker, type, 0, new Set());
}

/** Resolve an exported shared-type name to its `ts.Type`. */
function resolveExportedType(checker: ts.TypeChecker, typeName: string): ts.Type {
  const { source } = getProgram();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new Error(`ts-interface-required-keys: no module symbol for ${ENTRY}`);
  }
  const exported = checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === typeName);
  if (!exported) {
    throw new Error(
      `ts-interface-required-keys: "${typeName}" is not exported from @appstrate/shared-types`,
    );
  }
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const declaration = symbol.declarations?.[0];
  if (!declaration) {
    throw new Error(`ts-interface-required-keys: "${typeName}" has no declaration`);
  }
  return checker.getTypeAtLocation(declaration);
}
