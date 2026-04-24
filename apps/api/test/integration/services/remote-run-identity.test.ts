// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the signature-based resolution of bundles posted
 * to `POST /api/runs/remote`. Without this helper every remote run lands
 * in the `@inline/…` shadow scope — even when the payload matches a
 * published version of a real agent.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { resolveRemoteAgentIdentity } from "../../../src/services/remote-run-identity.ts";
import { buildMinimalZip, uploadPackageZip } from "../../../src/services/package-storage.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const PROMPT = "You are a helpful agent.";

const PUBLISHED_MANIFEST = {
  name: "@acme/briefing",
  version: "1.2.3",
  type: "agent",
  timeout: 300,
  dependencies: { skills: [], tools: [], providers: [] },
  config: { schema: { type: "object", properties: { lang: { type: "string" } } } },
  output: { schema: { type: "object", properties: { summary: { type: "string" } } } },
} as const;

describe("resolveRemoteAgentIdentity", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "rri@test.dev", orgSlug: "acme" });

    await seedPackage({ orgId: ctx.orgId, id: "@acme/briefing", type: "agent" });
    await seedPackageVersion({
      packageId: "@acme/briefing",
      version: "1.2.3",
      integrity: "sha256-test",
      artifactSize: 2048,
      manifest: PUBLISHED_MANIFEST as unknown as Record<string, unknown>,
    });
    // Upload a matching artefact so `getVersionDetail` can read the prompt
    // back — without this the fingerprint always mismatches and the
    // happy-path branch would never be exercised.
    const zip = buildMinimalZip(PUBLISHED_MANIFEST as unknown as Record<string, unknown>, PROMPT);
    await uploadPackageZip("@acme/briefing", "1.2.3", zip);
  });

  it("resolves a published version when manifest + prompt match", async () => {
    const resolved = await resolveRemoteAgentIdentity({
      orgId: ctx.orgId,
      manifest: PUBLISHED_MANIFEST as unknown as AgentManifest,
      prompt: PROMPT,
    });
    expect(resolved).toEqual({ packageId: "@acme/briefing", versionLabel: "1.2.3" });
  });

  it("returns null when the version is not found", async () => {
    const resolved = await resolveRemoteAgentIdentity({
      orgId: ctx.orgId,
      manifest: { ...PUBLISHED_MANIFEST, version: "9.9.9" } as unknown as AgentManifest,
      prompt: PROMPT,
    });
    expect(resolved).toBeNull();
  });

  it("returns null when the manifest has no name or version", async () => {
    expect(
      await resolveRemoteAgentIdentity({
        orgId: ctx.orgId,
        manifest: { type: "agent" } as unknown as AgentManifest,
        prompt: PROMPT,
      }),
    ).toBeNull();
    expect(
      await resolveRemoteAgentIdentity({
        orgId: ctx.orgId,
        manifest: { name: "@acme/briefing", type: "agent" } as unknown as AgentManifest,
        prompt: PROMPT,
      }),
    ).toBeNull();
  });

  it("returns null on cross-org package access (enterprise isolation)", async () => {
    const other = await createTestContext({ email: "other@test.dev", orgSlug: "other-org" });
    const resolved = await resolveRemoteAgentIdentity({
      orgId: other.orgId,
      manifest: PUBLISHED_MANIFEST as unknown as AgentManifest,
      prompt: PROMPT,
    });
    expect(resolved).toBeNull();
  });

  it("refuses divergent prompts even when name + version match", async () => {
    const resolved = await resolveRemoteAgentIdentity({
      orgId: ctx.orgId,
      manifest: PUBLISHED_MANIFEST as unknown as AgentManifest,
      prompt: "I am a different agent masquerading as the published one.",
    });
    expect(resolved).toBeNull();
  });

  it("refuses divergent output schemas even when prompt matches", async () => {
    const tampered: AgentManifest = {
      ...PUBLISHED_MANIFEST,
      output: { schema: { type: "object", properties: { evil: { type: "string" } } } },
    } as unknown as AgentManifest;
    const resolved = await resolveRemoteAgentIdentity({
      orgId: ctx.orgId,
      manifest: tampered,
      prompt: PROMPT,
    });
    expect(resolved).toBeNull();
  });
});
