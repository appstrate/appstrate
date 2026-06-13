// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the property keys (and which of them are required) of an exported
 * type from `@appstrate/shared-types`, using the TypeScript Compiler API.
 *
 * Used by verify-openapi step #7 to compare a shared-type's required fields
 * against the OpenAPI response schema that is supposed to mirror it.
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
 * List every type/interface name exported from `@appstrate/shared-types`.
 * Used by verify-openapi step #7 to auto-discover spec-schema ↔ shared-type
 * pairs so a response schema with a matching type can't silently escape the
 * required-field gate.
 */
export function listExportedTypes(): Set<string> {
  const { checker, source } = getProgram();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new Error(`ts-interface-required-keys: no module symbol for ${ENTRY}`);
  }
  const names = new Set<string>();
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    // Keep only type-space exports (interfaces + type aliases), not values.
    if (sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      names.add(exp.getName());
    }
  }
  return names;
}

/**
 * Return the property keys of the exported type `typeName`, split into the
 * required subset and the full set. Throws if the type is not an exported
 * member of `@appstrate/shared-types`.
 */
export function getInterfaceKeys(typeName: string): {
  required: Set<string>;
  all: Set<string>;
} {
  const { checker, source } = getProgram();

  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new Error(`ts-interface-required-keys: no module symbol for ${ENTRY}`);
  }

  const exports = checker.getExportsOfModule(moduleSymbol);
  const exported = exports.find((s) => s.getName() === typeName);
  if (!exported) {
    throw new Error(
      `ts-interface-required-keys: "${typeName}" is not exported from @appstrate/shared-types`,
    );
  }

  // Resolve aliases (re-exports) to the underlying declared symbol.
  const symbol =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;

  const declaration = symbol.declarations?.[0];
  if (!declaration) {
    throw new Error(`ts-interface-required-keys: "${typeName}" has no declaration`);
  }

  const type = checker.getTypeAtLocation(declaration);
  const props = checker.getPropertiesOfType(type);

  const required = new Set<string>();
  const all = new Set<string>();
  for (const prop of props) {
    const name = prop.getName();
    all.add(name);
    if (!(prop.flags & ts.SymbolFlags.Optional)) {
      required.add(name);
    }
  }

  return { required, all };
}
