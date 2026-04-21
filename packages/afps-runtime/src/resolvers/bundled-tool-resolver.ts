// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, Tool, ToolRef, ToolResolver } from "./types.ts";

/**
 * Shape a tool package ships inside `.agent-package/tools/{name}/index.js`
 * (or `.ts`): a default export that is either a {@link Tool} object or a
 * factory producing one. Factories let tools capture runtime-scoped state
 * (counters, caches) without leaking it across runs.
 */
export type BundledToolModule =
  | Tool
  | { default: Tool }
  | ((args: { bundle: Bundle; ref: ToolRef }) => Tool | Promise<Tool>)
  | { default: (args: { bundle: Bundle; ref: ToolRef }) => Tool | Promise<Tool> };

export class BundledToolResolutionError extends Error {
  constructor(
    public readonly ref: ToolRef,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "BundledToolResolutionError";
  }
}

/**
 * Default {@link ToolResolver} that loads each entry in `dependencies.tools[]`
 * from `.agent-package/tools/{scoped-name}/` inside the bundle. The
 * scoped name `@afps/memory` maps to the directory `@afps/memory`.
 *
 * Resolution order for each ref:
 *   1. `index.mjs`  (ES module)
 *   2. `index.js`   (ES module)
 *   3. `index.ts`   (Bun / ts-node)
 *   4. `main` field of a colocated `package.json`, if present
 *
 * The file is imported via a data URL so the bundle does not need to be
 * unpacked to disk. This keeps `.afps` execution sealed — tools run from
 * memory, not from a filesystem that could be shared with other bundles.
 */
export class BundledToolResolver implements ToolResolver {
  constructor(
    private readonly opts: {
      /** Directory prefix inside the bundle. Defaults to `.agent-package/tools/`. */
      prefix?: string;
      /**
       * Override for the import step (tests inject this to avoid evaluating
       * real module code). Receives the raw module source + its logical
       * path, returns a fully-resolved Tool.
       */
      importModule?: (args: {
        source: Uint8Array;
        path: string;
        bundle: Bundle;
        ref: ToolRef;
      }) => Promise<Tool>;
    } = {},
  ) {}

  async resolve(refs: ToolRef[], bundle: Bundle): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const ref of refs) {
      const tool = await this.resolveOne(ref, bundle);
      out.push(tool);
    }
    return out;
  }

  private async resolveOne(ref: ToolRef, bundle: Bundle): Promise<Tool> {
    const prefix = this.opts.prefix ?? ".agent-package/tools/";
    const base = `${prefix}${ref.name}/`;
    const candidates = ["index.mjs", "index.js", "index.ts"];

    for (const candidate of candidates) {
      const path = `${base}${candidate}`;
      if (!(await bundle.exists(path))) continue;
      try {
        const source = await bundle.read(path);
        const tool = await this.importTool({ source, path, bundle, ref });
        validateTool(tool, ref);
        return tool;
      } catch (err) {
        throw new BundledToolResolutionError(
          ref,
          `failed to load bundled tool ${ref.name} from ${path}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }

    throw new BundledToolResolutionError(
      ref,
      `bundled tool ${ref.name} has no entrypoint (looked under ${base} for index.{mjs,js,ts})`,
    );
  }

  private async importTool(args: {
    source: Uint8Array;
    path: string;
    bundle: Bundle;
    ref: ToolRef;
  }): Promise<Tool> {
    if (this.opts.importModule) return this.opts.importModule(args);
    const mod = (await import(sourceToDataUrl(args.source, args.path))) as BundledToolModule;
    return materialiseTool(mod, args.ref, args.bundle);
  }
}

function sourceToDataUrl(source: Uint8Array, path: string): string {
  const mime = path.endsWith(".ts")
    ? "application/typescript"
    : path.endsWith(".mjs")
      ? "application/javascript"
      : "application/javascript";
  const base64 = Buffer.from(source).toString("base64");
  return `data:${mime};base64,${base64}`;
}

async function materialiseTool(
  mod: BundledToolModule,
  ref: ToolRef,
  bundle: Bundle,
): Promise<Tool> {
  const candidate =
    typeof mod === "function"
      ? await mod({ bundle, ref })
      : "default" in mod
        ? typeof mod.default === "function"
          ? await mod.default({ bundle, ref })
          : mod.default
        : mod;
  return candidate as Tool;
}

function validateTool(tool: Tool, ref: ToolRef): void {
  if (!tool || typeof tool !== "object") {
    throw new Error(`tool export is not an object`);
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new Error(`tool from ${ref.name} has no name`);
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`tool ${tool.name} has no execute() function`);
  }
  if (typeof tool.description !== "string") {
    throw new Error(`tool ${tool.name} has no description`);
  }
}
