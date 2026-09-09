// SPDX-License-Identifier: Apache-2.0

/**
 * The env vars a workspace MODULE declares, unioned with `packages/env`'s `envSchema` by the
 * gates holding `docs/ENV.md` and `.env.example` complete. Specifiers are COMPUTED: a platform
 * file may not name a module in a literal one (`verify-module-isolation.ts`).
 */

import { Glob } from "bun";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ZodLikeField {
  safeParse(value: unknown): { success: boolean };
}

interface ModuleEnvSchema {
  id: string;
  file: string;
  exportName: string;
  shape: Record<string, ZodLikeField>;
}

/** Structural, not nominal — the gate carries no Zod version of its own to `instanceof` against. */
function isZodObject(value: unknown): value is { shape: Record<string, ZodLikeField> } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { shape?: unknown; safeParse?: unknown };
  return typeof candidate.safeParse === "function" && typeof candidate.shape === "object";
}

export interface ModuleEnvFiles {
  schemas: ModuleEnvSchema[];
  /** `src/env.ts` exporting no Zod object: hand-read `process.env`, so hand-documented. */
  unstructured: { id: string; file: string }[];
}

/** Every `packages/module-*` with an `src/env.ts`, in id order; gates print both halves. */
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
