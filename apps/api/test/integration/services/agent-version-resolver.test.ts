// SPDX-License-Identifier: Apache-2.0

/**
 * resolveAgentRunVersion (#636) — which agent definition a run executes.
 *
 * Ground truth being pinned here: before #636, every platform run executed
 * the mutable draft while the run row was labeled with the latest published
 * semver (+ a persisted `version_ref`). The resolver makes the choice
 * explicit and deterministic:
 *
 *   - omitted  → strictly identical to "published" (latest published; 404
 *               `no_published_version` when none — never a silent draft)
 *   - "draft"  → the live draft (the one editor-only, opt-in selector)
 *   - "published" → latest published version (404 when none)
 *   - "<spec>" → exact / dist-tag / semver-range resolution (404 when none)
 *
 * Published selection substitutes the version snapshot's manifest + prompt
 * (read back from the stored version ZIP) — asserted via prompt content.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent } from "../../helpers/seed.ts";
import { packages } from "@appstrate/db/schema";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";

const AGENT = "@verorg/versioned-agent";
const PUBLISHED_PROMPT = "published prompt v1";
const DIRTY_PROMPT = "dirty draft prompt";

describe("resolveAgentRunVersion", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "verorg" });
  });

  /** Seed an agent, publish 1.0.0 from its draft, then dirty the draft. */
  async function seedPublishedDirtyAgent(): Promise<LoadedPackage> {
    await seedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        description: "Versioned agent",
      },
      draftContent: PUBLISHED_PROMPT,
    });

    const published = await createVersionFromDraft({
      packageId: AGENT,
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    expect("version" in published && published.version).toBe("1.0.0");

    // Dirty the draft AFTER publishing — content diverges, updatedAt moves
    // past the version's createdAt (explicit future stamp beats clock
    // resolution races).
    await db
      .update(packages)
      .set({ draftContent: DIRTY_PROMPT, updatedAt: new Date(Date.now() + 5_000) })
      .where(eq(packages.id, AGENT));

    const agent = await getPackage(AGENT, ctx.orgId);
    expect(agent).not.toBeNull();
    expect(agent!.prompt).toBe(DIRTY_PROMPT);
    return agent!;
  }

  it("default (selector omitted) executes the latest published version, not the dirty draft", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, undefined);

    expect(resolved.overrideVersionLabel).toBe("1.0.0");
    expect(resolved.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("treats an empty selector like an omitted one", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, "");

    expect(resolved.overrideVersionLabel).toBe("1.0.0");
    expect(resolved.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("'draft' executes the live draft (no version label override)", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, "draft");

    expect(resolved.overrideVersionLabel).toBeUndefined();
    expect(resolved.agent.prompt).toBe(DIRTY_PROMPT);
  });

  it("'published' executes the latest published version", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, "published");

    expect(resolved.overrideVersionLabel).toBe("1.0.0");
    expect(resolved.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("an exact version spec resolves that version", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, "1.0.0");

    expect(resolved.overrideVersionLabel).toBe("1.0.0");
    expect(resolved.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("a semver range resolves through the 3-step resolution", async () => {
    const agent = await seedPublishedDirtyAgent();

    const resolved = await resolveAgentRunVersion(agent, "^1.0.0");

    expect(resolved.overrideVersionLabel).toBe("1.0.0");
    expect(resolved.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("an unresolvable spec throws 404 — never a silent draft fallback", async () => {
    const agent = await seedPublishedDirtyAgent();

    expect(resolveAgentRunVersion(agent, "9.9.9")).rejects.toThrow(ApiError);
    try {
      await resolveAgentRunVersion(agent, "9.9.9");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });

  // CRITICAL behavior (unified version model): the omitted selector is now
  // strictly identical to "published" — a never-published agent run WITHOUT a
  // selector throws 404 `no_published_version` rather than silently executing
  // the working copy. Running the draft is opt-in via `version=draft` only.
  it("default (omitted) on a never-published agent throws 404 no_published_version", async () => {
    await seedAgent({
      id: "@verorg/never-published",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftContent: DIRTY_PROMPT,
    });
    const agent = await getPackage("@verorg/never-published", ctx.orgId);

    try {
      await resolveAgentRunVersion(agent!, undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe("no_published_version");
    }
  });

  it("empty selector on a never-published agent also throws 404 (== omitted)", async () => {
    await seedAgent({
      id: "@verorg/never-published",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftContent: DIRTY_PROMPT,
    });
    const agent = await getPackage("@verorg/never-published", ctx.orgId);

    expect(resolveAgentRunVersion(agent!, "")).rejects.toThrow(ApiError);
  });

  it("'published' on a never-published agent throws 404 no_published_version", async () => {
    await seedAgent({
      id: "@verorg/never-published",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    const agent = await getPackage("@verorg/never-published", ctx.orgId);

    try {
      await resolveAgentRunVersion(agent!, "published");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe("no_published_version");
    }
  });

  it("default does not infer a published version from prerelease-only snapshots", async () => {
    const id = "@verorg/beta-only";
    await seedAgent({
      id,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: id,
        version: "1.0.0-beta.1",
        type: "agent",
        description: "Prerelease-only agent",
      },
      draftContent: PUBLISHED_PROMPT,
    });
    const published = await createVersionFromDraft({
      packageId: id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    expect("version" in published && published.version).toBe("1.0.0-beta.1");

    await db
      .update(packages)
      .set({ draftContent: DIRTY_PROMPT, updatedAt: new Date(Date.now() + 5_000) })
      .where(eq(packages.id, id));
    const agent = await getPackage(id, ctx.orgId);
    expect(agent).not.toBeNull();

    try {
      await resolveAgentRunVersion(agent!, undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe("no_published_version");
    }

    const exact = await resolveAgentRunVersion(agent!, "1.0.0-beta.1");
    expect(exact.overrideVersionLabel).toBe("1.0.0-beta.1");
    expect(exact.agent.prompt).toBe(PUBLISHED_PROMPT);
  });

  it("'draft' STILL runs the working copy on a never-published agent (the opt-in escape hatch)", async () => {
    await seedAgent({
      id: "@verorg/never-published",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftContent: DIRTY_PROMPT,
    });
    const agent = await getPackage("@verorg/never-published", ctx.orgId);

    const resolved = await resolveAgentRunVersion(agent!, "draft");

    expect(resolved.overrideVersionLabel).toBeUndefined();
    expect(resolved.agent.prompt).toBe(DIRTY_PROMPT);
  });

  it("ignores the selector for system agents (definition ships with the platform)", async () => {
    const agent = await seedPublishedDirtyAgent();
    const systemAgent: LoadedPackage = { ...agent, source: "system" };

    const resolved = await resolveAgentRunVersion(systemAgent, "published");

    expect(resolved.overrideVersionLabel).toBeUndefined();
    expect(resolved.agent).toBe(systemAgent);
  });
});
