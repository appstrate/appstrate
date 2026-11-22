// SPDX-License-Identifier: Apache-2.0

// The chat UI (src/ui/**) ships in the browser bundle, and so does every module it reaches
// outside src/ui. One server import there (the pino logger, `process.env`) throws when the chat
// chunk evaluates and takes the whole chat page down — so walk the runtime import graph and refuse it.

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const UI = join(SRC, "ui");

// `import … from "x"` / `export … from "x"` / bare `import "x"`, skipping type-only forms.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function runtimeImports(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => match[1]!);
}

// `@appstrate/db/run-status` is the one db subpath kept import-free for the SPA.
const FORBIDDEN_SPECIFIERS = [
  /^@appstrate\/db(?!\/run-status$)(\/|$)/,
  /^@appstrate\/core\/logger$/,
  /^node:/,
  /^bun$/,
];

describe("chat UI import graph", () => {
  it("reaches no server-only module", async () => {
    const queue: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan(UI)) queue.push(join(UI, file));

    const seen = new Set<string>();
    const violations: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const name = relative(SRC, file);
      if (name === "logger.ts") violations.push(`${name}: the server logger`);
      const source = await Bun.file(file).text();
      if (/\bprocess\.env\b/.test(source)) violations.push(`${name}: reads process.env`);
      for (const spec of runtimeImports(source)) {
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
        else if (FORBIDDEN_SPECIFIERS.some((re) => re.test(spec))) {
          violations.push(`${name}: imports ${spec}`);
        }
      }
    }

    expect(seen.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
