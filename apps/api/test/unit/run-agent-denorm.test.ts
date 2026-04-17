// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for extractRunAgentDenorm — the denormalization helper that
 * captures the agent's @scope and display-name at run creation so the
 * global /runs view survives rename / delete / compaction.
 */

import { describe, it, expect } from "bun:test";
import { extractRunAgentDenorm } from "../../src/services/run-pipeline.ts";
import type { LoadedPackage } from "../../src/types/index.ts";

function pkg(id: string, manifest: Record<string, unknown>): LoadedPackage {
  return {
    id,
    // @ts-expect-error — manifest shape is loose at the type boundary
    manifest,
    prompt: "",
    skills: [],
    tools: [],
    source: "local",
  };
}

describe("extractRunAgentDenorm", () => {
  it("parses scope from a canonical @scope/name ID", () => {
    const result = extractRunAgentDenorm(
      pkg("@acme/agent-foo", { displayName: "Foo", name: "@acme/agent-foo" }),
    );
    expect(result.scope).toBe("acme");
    expect(result.name).toBe("Foo");
  });

  it("falls back to manifest.name when displayName is absent", () => {
    const result = extractRunAgentDenorm(pkg("@acme/bar", { name: "@acme/bar" }));
    expect(result.name).toBe("@acme/bar");
  });

  it("returns null name when both displayName and name are missing", () => {
    const result = extractRunAgentDenorm(pkg("@acme/bar", {}));
    expect(result.name).toBeNull();
    expect(result.scope).toBe("acme");
  });

  it("returns null scope for a malformed (non-scoped) ID", () => {
    const result = extractRunAgentDenorm(pkg("not-scoped", { displayName: "X" }));
    expect(result.scope).toBeNull();
    expect(result.name).toBe("X");
  });

  it("handles ephemeral-style shadow package IDs", () => {
    const result = extractRunAgentDenorm(
      pkg("@inline/r-abc123", { displayName: "Inline Run", name: "@acme/real-agent" }),
    );
    expect(result.scope).toBe("inline");
    expect(result.name).toBe("Inline Run");
  });
});
