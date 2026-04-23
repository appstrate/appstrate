// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  bundleTool,
  PI_SDK_EXTERNALS,
  TOOL_BUNDLE_MAX_BYTES,
  ToolBundlerError,
} from "../src/tool-bundler.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("bundleTool", () => {
  test("inlines local relative imports", async () => {
    const files = {
      "tool.ts": enc(
        `import { greet } from "./helpers.ts";\nexport default () => greet("world");\n`,
      ),
      "helpers.ts": enc(`export function greet(n: string) { return "hello " + n; }\n`),
    };

    const { compiled } = await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/inline" });
    const text = dec(compiled);

    // No relative import should survive the bundle
    expect(text).not.toContain(`from "./helpers.ts"`);
    expect(text).not.toContain(`from './helpers.ts'`);
    // The helper body must be inlined
    expect(text).toContain(`"hello "`);
  });

  test("keeps Pi SDK value imports external", async () => {
    // We use only value imports here — TypeScript strips type-only
    // imports before the bundler sees them, so their presence in the
    // output cannot be asserted on a type-only import. Both Pi SDK
    // packages expose runtime exports, so each is exercised via one.
    const files = {
      "tool.ts": enc(
        [
          `import { Type } from "@mariozechner/pi-ai";`,
          `import { registerTool } from "@mariozechner/pi-coding-agent";`,
          `export default function register() {`,
          `  void Type;`,
          `  void registerTool;`,
          `  return 1;`,
          `}`,
        ].join("\n"),
      ),
    };

    const { compiled } = await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/ext" });
    const text = dec(compiled);

    expect(text).toContain(`"@mariozechner/pi-ai"`);
    expect(text).toContain(`"@mariozechner/pi-coding-agent"`);
    // The two externals must be exactly what PI_SDK_EXTERNALS advertises.
    expect([...PI_SDK_EXTERNALS]).toEqual(["@mariozechner/pi-ai", "@mariozechner/pi-coding-agent"]);
  });

  test("produces a byte-stable output for identical input", async () => {
    const files = {
      "tool.ts": enc(`export default () => 42;\n`),
    };
    const a = await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/det-a" });
    const b = await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/det-b" });

    expect(a.compiled.byteLength).toBe(b.compiled.byteLength);
    expect(dec(a.compiled)).toBe(dec(b.compiled));
  });

  test("rejects missing entrypoint", async () => {
    const files = { "other.ts": enc("export default () => null;") };
    try {
      await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/missing" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolBundlerError);
      expect((err as ToolBundlerError).code).toBe("INVALID_ENTRYPOINT");
    }
  });

  test("rejects path-traversal entrypoint", async () => {
    const files = { "tool.ts": enc("export default () => null;") };
    try {
      await bundleTool({ files, entrypoint: "../etc/passwd", toolId: "@t/trav" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolBundlerError);
      expect((err as ToolBundlerError).code).toBe("INVALID_ENTRYPOINT");
    }
  });

  test("rejects absolute-path entrypoint", async () => {
    const files = { "tool.ts": enc("export default () => null;") };
    try {
      await bundleTool({ files, entrypoint: "/etc/passwd", toolId: "@t/abs" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolBundlerError);
      expect((err as ToolBundlerError).code).toBe("INVALID_ENTRYPOINT");
    }
  });

  test("wraps bundler syntax errors as BUNDLE_FAILED", async () => {
    const files = {
      "tool.ts": enc("export default () => { this is not valid typescript"),
    };
    try {
      await bundleTool({ files, entrypoint: "tool.ts", toolId: "@t/bad-syntax" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolBundlerError);
      expect((err as ToolBundlerError).code).toBe("BUNDLE_FAILED");
    }
  });

  test("TOOL_BUNDLE_MAX_BYTES is 2 MiB", () => {
    expect(TOOL_BUNDLE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
