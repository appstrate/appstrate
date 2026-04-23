// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { Bundle, BundlePackage, Tool, ToolRef, ToolResolver } from "./types.ts";
import { resolvePackageRef } from "./bundle-adapter.ts";
import { resolveToolEntrypoint } from "../bundle/tool-entrypoint.ts";

/**
 * Shape a tool package ships inside the file pointed at by
 * `manifest.entrypoint`: a default export that is either a {@link Tool}
 * object or a factory producing one. Factories let tools capture
 * runtime-scoped state (counters, caches) without leaking it across runs.
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
 * Default {@link ToolResolver} that loads each entry in
 * `dependencies.tools[]` from the corresponding package inside the
 * {@link Bundle}. Honors the AFPS §3.4 contract: reads the file
 * named by `manifest.entrypoint` (in a published archive, a single
 * self-contained bundle), with no path-convention fallback.
 *
 * The file is imported via a data URL so the bundle does not need to
 * be unpacked to disk. This keeps bundle execution sealed — tools run
 * from memory, not from a filesystem that could be shared with other
 * bundles.
 */
export class BundledToolResolver implements ToolResolver {
  constructor(
    private readonly opts: {
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
    const pkg = resolvePackageRef(bundle, ref);
    if (!pkg) {
      throw new BundledToolResolutionError(
        ref,
        `bundled tool ${ref.name} is not present in the bundle`,
      );
    }
    let entrypoint: string;
    let source: Uint8Array;
    try {
      // §3.4 entrypoint validation is delegated to the shared helper —
      // every AFPS loader uses the same implementation.
      ({ entrypoint, bytes: source } = resolveToolEntrypoint(pkg, ref.name));
    } catch (err) {
      throw new BundledToolResolutionError(
        ref,
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
    try {
      const tool = await this.importTool({
        source,
        path: `${pkg.identity}/${entrypoint}`,
        bundle,
        ref,
        pkg,
      });
      validateTool(tool, ref);
      return tool;
    } catch (err) {
      if (err instanceof BundledToolResolutionError) throw err;
      throw new BundledToolResolutionError(
        ref,
        `failed to load bundled tool ${ref.name} from ${pkg.identity}/${entrypoint}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private async importTool(args: {
    source: Uint8Array;
    path: string;
    bundle: Bundle;
    ref: ToolRef;
    pkg: BundlePackage;
  }): Promise<Tool> {
    if (this.opts.importModule) {
      return this.opts.importModule({
        source: args.source,
        path: args.path,
        bundle: args.bundle,
        ref: args.ref,
      });
    }
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
