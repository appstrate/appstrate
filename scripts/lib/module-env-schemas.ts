// SPDX-License-Identifier: Apache-2.0

/**
 * The environment variables a workspace MODULE declares, for the two gates that
 * hold `docs/ENV.md`, `.env.example` and the compose files to a schema.
 *
 * Both gates union this with `packages/env`'s `envSchema`. Reading the platform
 * schema alone would let a variable declared in `packages/module-ee/src/env.ts`
 * pass both: it is in no platform schema, and neither gate would know another
 * one exists. From an operator's side the distinction is invisible — the module
 * ships in the same image, reads the same `process.env`, and fails to boot with
 * the same "Required" if the variable is missing.
 *
 * Discovery is by glob and the import specifier is COMPUTED, both deliberately:
 * a hardcoded roster stops covering the next module silently, and
 * `scripts/verify-module-isolation.ts` forbids a platform file from naming a
 * module in a literal specifier — these schemas sit on the other side of the
 * licence boundary and the gate reads them, it does not carry them.
 */

import { Glob } from "bun";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** As much of a Zod field as these gates ask of it. */
interface ZodLikeField {
  safeParse(value: unknown): { success: boolean };
}

/** One module's env schema, as the gates consume it. */
interface ModuleEnvSchema {
  /** Module id with `module-` stripped — `ee`. */
  id: string;
  /** Repo-relative path of the file that declares it. */
  file: string;
  /** The exported binding names that contributed, comma-joined, for the failure message. */
  exportName: string;
  /** The union of every exported Zod object's `shape` — key → field. */
  shape: Record<string, ZodLikeField>;
}

/**
 * Does `value` look like a Zod object schema?
 *
 * Structural, not nominal: these files are imported across the licence
 * boundary and the gate must not carry a Zod version of its own to
 * `instanceof` against.
 */
function isZodObject(value: unknown): value is { shape: Record<string, ZodLikeField> } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { shape?: unknown; safeParse?: unknown };
  return typeof candidate.safeParse === "function" && typeof candidate.shape === "object";
}

/** What a `packages/module-*` tree declares about its environment. */
export interface ModuleEnvFiles {
  /** Modules whose `src/env.ts` exports a Zod object — the keys held to the docs. */
  schemas: ModuleEnvSchema[];
  /**
   * Modules with an `src/env.ts` that exports no Zod object, because they read
   * `process.env` by hand (`module-observability`'s `OTEL_*`). Their names
   * cannot be derived, so they stay hand-documented — they are returned so the
   * gates can PRINT the split instead of silently covering half the population.
   */
  unstructured: { id: string; file: string }[];
}

/**
 * Every `packages/module-*` package that ships an `src/env.ts`, in id order.
 *
 * The two halves are kept apart rather than merged into "what we could read":
 * a module that stops exporting its schema would otherwise leave both gates
 * green over an uncovered variable set, which is the failure this closes
 * rebuilt one level up. The count line of each gate prints both numbers, so a
 * schema dropping out of the first list is visible where the verdict is read.
 */
export async function moduleEnvSchemas(repoRoot: string): Promise<ModuleEnvFiles> {
  const packagesDir = resolve(repoRoot, "packages");
  const schemas: ModuleEnvSchema[] = [];
  const unstructured: { id: string; file: string }[] = [];
  const glob = new Glob("module-*/src/env.ts");
  for await (const rel of glob.scan({ cwd: packagesDir })) {
    if (rel.includes("node_modules/")) continue;
    const abs = resolve(packagesDir, rel);
    const id = rel.slice(0, rel.indexOf("/")).replace(/^module-/, "");
    const file = `packages/${rel}`;
    const loaded = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    // EVERY exported Zod object, unioned — not the first one found. A module
    // that splits its variables across two schemas (a required half and an
    // optional one, say) would otherwise have the second half read by no gate
    // at all, which is the silent-coverage-hole this file exists to close, one
    // level down. A key declared by two of them is one key either way: the
    // gates hold NAMES to the docs, and the field they end up with is the last
    // export's.
    const zodExports = Object.entries(loaded).filter(
      (entry): entry is [string, { shape: Record<string, ZodLikeField> }] => isZodObject(entry[1]),
    );
    if (zodExports.length === 0) {
      unstructured.push({ id, file });
      continue;
    }
    const shape: Record<string, ZodLikeField> = {};
    for (const [, schema] of zodExports) Object.assign(shape, schema.shape);
    schemas.push({
      id,
      file,
      exportName: zodExports.map(([name]) => name).join(", "),
      shape,
    });
  }
  schemas.sort((a, b) => a.id.localeCompare(b.id));
  unstructured.sort((a, b) => a.id.localeCompare(b.id));
  return { schemas, unstructured };
}
