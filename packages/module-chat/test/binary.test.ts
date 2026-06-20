// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { resolveClaudeCodeBinary } from "../src/claude-agent/binary.ts";

// The pure per-arch matrix + fall-through logic is covered in
// `@appstrate/core` (`test/claude-binary.test.ts`). What's left to validate
// HERE is that THIS package's SDK install actually placed a usable binary —
// the scope-anchored shim must resolve it against `module-chat`'s own
// `node_modules`. A miss would otherwise surface as an opaque SDK spawn crash
// at the first chat turn.
describe("resolveClaudeCodeBinary (host integration)", () => {
  test("resolves the installed native binary on this host", () => {
    const path = resolveClaudeCodeBinary();
    expect(path).toContain("claude-agent-sdk-");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1_000_000);
  });
});
