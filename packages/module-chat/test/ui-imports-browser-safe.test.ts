// SPDX-License-Identifier: Apache-2.0

// The chat UI (src/ui/**) ships in the browser bundle, and so does every module it reaches
// outside src/ui — the workspace packages it imports included. One server import there (the pino
// logger, `node:crypto`, `process.env`) throws when the chat chunk evaluates and takes the whole
// chat page down — so walk the runtime import graph, through `@appstrate/*` sources, and refuse it.

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const UI = join(SRC, "ui");
const ROOT = resolve(import.meta.dir, "../../..");

// `import … from "x"` / `export … from "x"` / bare `import "x"`, skipping type-only forms.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function runtimeImports(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => match[1]!);
}

// The allowed exceptions are the negative lookaheads: `@appstrate/db/run-status` is the one db
// subpath kept import-free for the SPA.
const FORBIDDEN_SPECIFIERS = [
  /^@appstrate\/db(?!\/run-status$)(\/|$)/,
  /^@appstrate\/core\/logger$/,
  /^node:/,
  /^bun$/,
];

interface Workspace {
  dir: string;
  exports: Record<string, string>;
}

/** Every `@appstrate/*` workspace package, by name, with its `exports` map. */
function workspaces(): Map<string, Workspace> {
  const map = new Map<string, Workspace>();
  for (const pattern of ["packages/*/package.json", "apps/*/package.json"]) {
    for (const file of new Glob(pattern).scanSync(ROOT)) {
      const manifest = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as {
        name?: string;
        exports?: Record<string, string> | string;
      };
      if (!manifest.name?.startsWith("@appstrate/")) continue;
      const exportsMap =
        typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
      map.set(manifest.name, { dir: dirname(join(ROOT, file)), exports: exportsMap });
    }
  }
  return map;
}

/** The source file an `@appstrate/*` specifier resolves to through its package's `exports` map. */
function resolveWorkspace(spec: string, packages: Map<string, Workspace>): string | null {
  const [, pkgName, sub] = /^(@appstrate\/[^/]+)(\/.*)?$/.exec(spec) ?? [];
  const pkg = pkgName ? packages.get(pkgName) : undefined;
  if (!pkg) return null;
  const key = sub ? `.${sub}` : ".";
  const exact = pkg.exports[key];
  if (typeof exact === "string") return join(pkg.dir, exact);
  for (const [pattern, target] of Object.entries(pkg.exports)) {
    const star = pattern.indexOf("*");
    if (star < 0 || typeof target !== "string") continue;
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)];
    if (key.startsWith(head) && key.endsWith(tail) && key.length >= head.length + tail.length) {
      return join(pkg.dir, target.replace("*", key.slice(head.length, key.length - tail.length)));
    }
  }
  return null;
}

/** A relative specifier as a file: as written, else with a source extension or an index. */
function resolveFile(base: string): string {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? base
  );
}

describe("chat UI import graph", () => {
  it("reaches no server-only module, in the chat's sources or in a workspace package's", async () => {
    const packages = workspaces();
    const queue: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan(UI)) queue.push(join(UI, file));

    const seen = new Set<string>();
    const violations: string[] = [];
    let followed = 0;
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!file.startsWith(SRC)) followed++;
      const name = relative(ROOT, file);
      if (file === join(SRC, "logger.ts")) violations.push(`${name}: the server logger`);
      const source = await Bun.file(file).text();
      if (/\bprocess\.env\b/.test(source)) violations.push(`${name}: reads process.env`);
      for (const spec of runtimeImports(source)) {
        if (FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) {
          violations.push(`${name}: imports ${spec}`);
        } else if (spec.startsWith(".")) {
          queue.push(resolveFile(resolve(dirname(file), spec)));
        } else if (spec.startsWith("@appstrate/")) {
          const target = resolveWorkspace(spec, packages);
          if (target) queue.push(target);
          else violations.push(`${name}: ${spec} resolves to no workspace source`);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    // The walk does leave the chat: the workspace sources are checked too.
    expect(followed).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
