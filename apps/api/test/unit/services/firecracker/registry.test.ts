// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  registerOrchestrator,
  selectOrchestrator,
  listOrchestratorIds,
} from "../../../../src/services/orchestrator/registry.ts";
import type { RunOrchestrator } from "@appstrate/core/platform-types";

// The registry is process-global (built-ins may already be registered by
// other suites importing orchestrator/index.ts) — use test-unique ids.
const fake = { marker: "fake" } as unknown as RunOrchestrator;

describe("orchestrator registry", () => {
  it("resolves a registered backend by id", () => {
    registerOrchestrator({ id: "test-backend-a", create: () => fake });
    expect(selectOrchestrator("test-backend-a")).toBe(fake);
    expect(listOrchestratorIds()).toContain("test-backend-a");
  });

  it("rejects duplicate registrations", () => {
    registerOrchestrator({ id: "test-backend-dup", create: () => fake });
    expect(() => registerOrchestrator({ id: "test-backend-dup", create: () => fake })).toThrow(
      /already registered/,
    );
  });

  it("names the known backends when the id is unknown", () => {
    expect(() => selectOrchestrator("no-such-backend")).toThrow(/registered orchestrators:/);
  });
});
