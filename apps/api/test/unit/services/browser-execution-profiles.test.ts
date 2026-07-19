// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import {
  getBrowserResourceProfile,
  hasExecutionRequirements,
  MAX_BROWSER_INSTANCES_PER_RUN,
  resolveBrowserExecutionRequirements,
} from "../../../src/services/browser-execution-profiles.ts";

function integration(id: string, browser = true): IntegrationSpawnSpec {
  return {
    integrationId: id,
    namespace: id,
    sourceKind: "local",
    manifest: {
      name: id,
      version: "1.0.0",
      server: { type: "bun", entry_point: "server.ts", packageId: `${id}-server` },
    },
    spawnEnv: {},
    ...(browser
      ? {
          browser: {
            purpose: "automation" as const,
            protocol: "cdp-v1" as const,
            profile: "standard" as const,
            allowedOrigins: ["https://example.com"],
            sessionMode: "none" as const,
            trustedDriver: false,
          },
        }
      : {}),
  };
}

describe("browser execution profiles", () => {
  it("exposes the platform-owned standard profile", () => {
    expect(getBrowserResourceProfile("standard")).toEqual({
      id: "standard",
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
      shmBytes: 256 * 1024 * 1024,
      maxContexts: 1,
      maxPages: 4,
    });
  });

  it("fails closed for an unknown profile", () => {
    expect(() => getBrowserResourceProfile("package-controlled-large")).toThrow(
      /unsupported browser execution profile/,
    );
  });

  it("returns empty requirements for a browser-free run", () => {
    const requirements = resolveBrowserExecutionRequirements([integration("@test/plain", false)]);
    expect(requirements).toEqual({
      capabilities: [],
      supplementalResources: { memoryBytes: 0, nanoCpus: 0, pidsLimit: 0 },
    });
    expect(hasExecutionRequirements(requirements)).toBe(false);
  });

  it("aggregates one isolated browser companion per integration", () => {
    const requirements = resolveBrowserExecutionRequirements([
      integration("@test/a"),
      integration("@test/b"),
    ]);
    expect(requirements.capabilities).toEqual([
      { kind: "browser", profile: "standard", instances: 2 },
    ]);
    expect(requirements.supplementalResources).toEqual({
      memoryBytes: 2 * 1024 * 1024 * 1024,
      nanoCpus: 2_000_000_000,
      pidsLimit: 512,
    });
    expect(hasExecutionRequirements(requirements)).toBe(true);
  });

  it("rejects a run above the platform browser-instance ceiling", () => {
    const specs = Array.from({ length: MAX_BROWSER_INSTANCES_PER_RUN + 1 }, (_, index) =>
      integration(`@test/browser-${index}`),
    );
    expect(() => resolveBrowserExecutionRequirements(specs)).toThrow(/maximum/);
  });
});
