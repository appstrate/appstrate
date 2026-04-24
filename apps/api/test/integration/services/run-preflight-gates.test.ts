// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the shared preflight gates that every run path
 * (platform, remote, scheduled) runs before spending any further
 * resources. These gates used to be copy-pasted between the platform
 * pipeline and the remote-run handler — the factorisation here prevents
 * future drift between them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { runPreflightGates } from "../../../src/services/run-preflight-gates.ts";
import { getPlatformRunLimits } from "../../../src/services/run-limits.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";

function loadedPackage(id: string, timeoutOverride?: number): LoadedPackage {
  return {
    id,
    manifest: {
      name: id,
      version: "0.1.0",
      schemaVersion: "1.3",
      displayName: id,
      type: "agent",
      ...(timeoutOverride !== undefined ? { timeout: timeoutOverride } : {}),
    } as unknown as LoadedPackage["manifest"],
    prompt: "x",
    skills: [],
    tools: [],
    source: "local",
  };
}

describe("runPreflightGates", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "gates@test.dev", orgSlug: "gates" });
    await seedPackage({ orgId: ctx.orgId, id: "@gates/agent", type: "agent" });
  });

  it("returns ok with an untouched agent when the manifest timeout is below the ceiling", async () => {
    const agent = loadedPackage("@gates/agent", 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      agent,
      providerProfiles: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agent.manifest.timeout).toBe(60);
  });

  it("caps the agent timeout to the platform ceiling without mutating the input", async () => {
    const limits = getPlatformRunLimits();
    const agent = loadedPackage("@gates/agent", limits.timeout_ceiling_seconds + 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      agent,
      providerProfiles: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.agent.manifest.timeout).toBe(limits.timeout_ceiling_seconds);
      // The caller's reference is untouched — rebinding happens via the
      // returned value, not by mutating the shared object.
      expect(agent.manifest.timeout).toBe(limits.timeout_ceiling_seconds + 60);
    }
  });
});
