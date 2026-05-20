// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the boot-time `dependencies.tools` → `runtimeTools`
 * migration helper. Exercises `migrateManifest` in isolation (no DB) — the
 * full `migrateAgentRuntimeTools` DB walk is covered by an integration test.
 *
 * The `tool` AFPS package type was removed: the former system tools
 * (output/log/note/pin/report) are now built-in runtime tools selected per
 * agent via the top-level `runtimeTools: string[]` manifest field.
 */

import { describe, it, expect } from "bun:test";
import { migrateManifest } from "../../src/services/migrate-runtime-tools-core.ts";

describe("migrateManifest", () => {
  it("is a no-op for manifests without dependencies", () => {
    const r = migrateManifest({ name: "@a/x", type: "agent" }, new Set());
    expect(r.changed).toBe(false);
    expect(r.manifest).toEqual({ name: "@a/x", type: "agent" });
  });

  it("is a no-op for non-object input", () => {
    const r = migrateManifest(null, new Set());
    expect(r.changed).toBe(false);
  });

  it("is a no-op when dependencies has no tools map", () => {
    const r = migrateManifest({ dependencies: { skills: { "@a/s": "^1" } } }, new Set());
    expect(r.changed).toBe(false);
  });

  it("drops the mandatory `output` tool (auto-injected, never listed)", () => {
    const unknown = new Set<string>();
    const r = migrateManifest({ dependencies: { tools: { "@appstrate/output": "^2" } } }, unknown);
    expect(r.changed).toBe(true);
    expect((r.manifest.dependencies as Record<string, unknown>).tools).toBeUndefined();
    // output is mandatory → not added to runtimeTools
    expect(r.manifest.runtimeTools).toBeUndefined();
    expect(unknown.size).toBe(0);
  });

  it("moves selectable tools (log/note/pin/report) into runtimeTools", () => {
    const unknown = new Set<string>();
    const r = migrateManifest(
      {
        dependencies: {
          tools: {
            "@appstrate/log": "^2",
            "@appstrate/note": "^2",
            "@appstrate/pin": "^2",
            "@appstrate/report": "^2",
          },
        },
      },
      unknown,
    );
    expect(r.changed).toBe(true);
    expect((r.manifest.dependencies as Record<string, unknown>).tools).toBeUndefined();
    expect((r.manifest.runtimeTools as string[]).sort()).toEqual(["log", "note", "pin", "report"]);
    expect(unknown.size).toBe(0);
  });

  it("preserves existing runtimeTools and dedups against the migrated set", () => {
    const r = migrateManifest(
      {
        runtimeTools: ["log", "pin"],
        dependencies: { tools: { "@appstrate/log": "^2", "@appstrate/note": "^2" } },
      },
      new Set(),
    );
    expect((r.manifest.runtimeTools as string[]).sort()).toEqual(["log", "note", "pin"]);
  });

  it("collects unknown third-party tool ids for fail-loud reporting", () => {
    const unknown = new Set<string>();
    const r = migrateManifest(
      {
        dependencies: {
          tools: { "@appstrate/log": "^2", "@vendor/custom-tool": "^1" },
        },
      },
      unknown,
    );
    // Known tool is migrated; unknown is recorded but not added.
    expect(r.changed).toBe(true);
    expect(r.manifest.runtimeTools).toEqual(["log"]);
    expect([...unknown]).toEqual(["@vendor/custom-tool"]);
  });

  it("preserves other dependency buckets while stripping tools", () => {
    const r = migrateManifest(
      {
        dependencies: {
          skills: { "@a/s": "^1" },
          providers: { "@a/p": "^1" },
          tools: { "@appstrate/note": "^2" },
        },
      },
      new Set(),
    );
    const deps = r.manifest.dependencies as Record<string, unknown>;
    expect(deps.skills).toEqual({ "@a/s": "^1" });
    expect(deps.providers).toEqual({ "@a/p": "^1" });
    expect(deps.tools).toBeUndefined();
  });
});
