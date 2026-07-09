// SPDX-License-Identifier: Apache-2.0

/**
 * The `missing_skill` readiness gate (#878).
 *
 * Ground truth being pinned here: the gate projects the declared skills off the
 * manifest it was handed, and off nothing else. It used to compare
 * `manifest.dependencies.skills` (which a published-version substitution had
 * replaced) against `LoadedPackage.skills` (which `getPackage` had resolved
 * from the DRAFT manifest and which the substitution left untouched). Any skill
 * the published version declared but the current draft no longer did was
 * reported as `missing_skill` — "not installed" — while being installed and
 * enabled.
 *
 * `LoadedPackage` no longer carries a resolved closure at all, so the two
 * halves cannot disagree: there is only one half. These tests exercise the gate
 * through both definitions of the same package to prove the projection follows
 * the manifest.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { collectAgentReadinessErrors } from "../../../src/services/agent-readiness.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { packages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import type { AgentManifest, LoadedPackage } from "../../../src/types/index.ts";

const AGENT = "@readyorg/drifted-agent";
const SKILL_X = "@readyorg/skill-x";
const SKILL_Y = "@readyorg/skill-y";

describe("readiness: missing_skill projects off the effective manifest", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "readyorg" });
  });

  /** Readiness with no actor — integration gating off, skills gate on. */
  async function skillErrors(agent: LoadedPackage): Promise<string[]> {
    const errors = await collectAgentReadinessErrors({
      agent,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: null,
    });
    return errors.filter((e) => e.code === "missing_skill").map((e) => e.field);
  }

  async function seedSkill(id: string): Promise<void> {
    await seedPackage({
      id,
      type: "skill",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: { name: id, version: "1.0.0", type: "skill" },
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
  }

  /**
   * Publish v1.0.0 declaring skill-x, then rewrite the draft to declare skill-y
   * instead without republishing — the shape reported in #878. Both skills are
   * installed and enabled the whole time.
   */
  async function seedDriftedAgent(): Promise<LoadedPackage> {
    await seedSkill(SKILL_X);
    await seedSkill(SKILL_Y);

    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        dependencies: { skills: { [SKILL_X]: "^1.0.0" } },
      },
      draftContent: "prompt",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
    await createVersionFromDraft({ packageId: AGENT, orgId: ctx.orgId, userId: ctx.user.id });

    await db
      .update(packages)
      .set({
        draftManifest: {
          name: AGENT,
          version: "1.2.0",
          type: "agent",
          dependencies: { skills: { [SKILL_Y]: "^1.0.0" } },
        },
        updatedAt: new Date(Date.now() + 5_000),
      })
      .where(eq(packages.id, AGENT));

    const agent = await getPackage(AGENT, ctx.orgId);
    expect(agent).not.toBeNull();
    return agent!;
  }

  it("reports nothing for a published run whose declared skill is installed", async () => {
    const agent = await seedDriftedAgent();
    const { agent: published } = await resolveAgentRunVersion(agent, "published");

    // The published manifest declares skill-x; the draft no longer does.
    expect(Object.keys(published.manifest.dependencies?.skills ?? {})).toEqual([SKILL_X]);
    expect(await skillErrors(published)).toEqual([]);
  });

  it("reports nothing for the draft run whose declared skill is installed", async () => {
    const agent = await seedDriftedAgent();
    const { agent: draft } = await resolveAgentRunVersion(agent, "draft");

    expect(Object.keys(draft.manifest.dependencies?.skills ?? {})).toEqual([SKILL_Y]);
    expect(await skillErrors(draft)).toEqual([]);
  });

  it("an omitted selector behaves exactly like published", async () => {
    const agent = await seedDriftedAgent();
    const { agent: implicitly } = await resolveAgentRunVersion(agent, undefined);

    expect(await skillErrors(implicitly)).toEqual([]);
  });

  // The gate must still fire when the skill genuinely is not in the catalog —
  // the fix removes false positives, not the check itself.
  it("still reports a declared skill that the org cannot see", async () => {
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        dependencies: { skills: { "@nonexistent/skill": "*" } },
      },
      draftContent: "prompt",
    });
    const agent = await getPackage(AGENT, ctx.orgId);

    expect(await skillErrors(agent!)).toEqual(["dependencies.skills.@nonexistent/skill"]);
  });

  it("does not accept a same-named skill owned by another org", async () => {
    const other = await createTestContext({ orgSlug: "otherorg" });
    await seedPackage({
      id: SKILL_X,
      type: "skill",
      orgId: other.orgId,
      createdBy: other.user.id,
      draftManifest: { name: SKILL_X, version: "1.0.0", type: "skill" },
    });
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        dependencies: { skills: { [SKILL_X]: "^1.0.0" } },
      },
      draftContent: "prompt",
    });
    const agent = await getPackage(AGENT, ctx.orgId);

    expect(await skillErrors(agent!)).toEqual([`dependencies.skills.${SKILL_X}`]);
  });

  // A manifest handed straight to the gate (inline runs build a shadow package
  // this way) resolves identically — no package row, no draft, nothing to go
  // stale against.
  it("resolves an inline manifest with no persisted package row", async () => {
    await seedSkill(SKILL_Y);
    const manifest = {
      name: "@inline/shadow",
      version: "1.0.0",
      type: "agent",
      dependencies: { skills: { [SKILL_Y]: "^1.0.0" } },
    } as unknown as AgentManifest;

    const shadow: LoadedPackage = {
      id: "@inline/shadow",
      manifest,
      prompt: "prompt",
      source: "local",
    };

    expect(await skillErrors(shadow)).toEqual([]);
  });
});
