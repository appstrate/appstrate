// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-resolution E2E (#666) — exercised against the REAL booted server.
 *
 * The resolution *correctness* (which version lands in the bundle: pin honored,
 * published-not-draft, range re-resolution) is asserted at the service layer in
 * `apps/api/test/integration/services/build-agent-package-bundle.test.ts`, where
 * the built bundle is inspectable. Over HTTP the resolved version is invisible
 * without running the container (Docker), so this suite covers the parts of the
 * #666 contract that ARE observable end-to-end on the wire, through the full
 * boot path (route → readiness → run-pipeline → buildAgentPackage):
 *
 *   1. the per-run `dependency_overrides` VALUE gate → 400 on a malformed spec,
 *      and pass-through on a well-formed one (the route is wired + parses it);
 *   2. an unsatisfiable pin — declared in the manifest OR forced via
 *      `dependency_overrides` — → 422 `dependency_unresolved` instead of a
 *      silent draft fallback, the core regression the issue was filed for.
 *
 * Both paths resolve BEFORE the container spawns: run-pipeline builds the bundle
 * synchronously (run-context-builder Step 1) and only then fires
 * `executeAgentInBackground`. So none of these need Docker, and the 422 is
 * reached ahead of the Step-2 model-resolution gate — no model required either.
 *
 * Note: creating a skill auto-publishes its initial version, so the loud-failure
 * repro is an out-of-range pin (`^9.0.0` against a published `1.0.0`), not a
 * never-published dep.
 */

import { test, expect } from "../../fixtures/api.fixture.ts";
import type { ApiClient } from "../../helpers/api-client.ts";

/** Create a skill package. Creating a skill auto-publishes version 1.0.0. */
async function createSkill(client: ApiClient, id: string): Promise<void> {
  const res = await client.post("/packages/skills", {
    manifest: {
      name: id,
      version: "1.0.0",
      type: "skill",
      schema_version: "0.1",
      display_name: "Dep Skill",
      description: "Dependency skill for the #666 resolution e2e.",
    },
    content: "---\nname: dep-skill\n---\n\nSkill body.",
  });
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create skill failed (${res.status()}): ${await res.text()}`);
  }
}

/** Create an agent, optionally with extra manifest fields (e.g. dependencies). */
async function createAgent(
  client: ApiClient,
  scope: string,
  name: string,
  manifestExtra: Record<string, unknown> = {},
): Promise<void> {
  const res = await client.post("/packages/agents", {
    manifest: {
      name: `${scope}/${name}`,
      version: "0.1.0",
      type: "agent",
      schema_version: "0.1",
      display_name: `Test Agent ${name}`,
      description: `E2E dependency-resolution agent ${name}`,
      ...manifestExtra,
    },
    content: "You are a test agent.",
  });
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Create agent failed (${res.status()}): ${await res.text()}`);
  }
}

test.describe("Run dependency resolution (#666)", () => {
  test("rejects a malformed dependency_overrides value with 400", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const name = `dep-ov-bad-${Date.now()}`;
    await createAgent(apiClient, scope, name);

    // `@x/y` is a syntactically valid package id; the SPEC value is garbage, so
    // the per-dependency value guard in parseRunInput must 400 (RFC 9457) and
    // name the offending field — before readiness or resolution ever run.
    const res = await apiClient.post(`/agents/${scope}/${name}/run`, {
      dependency_overrides: { "@x/y": "not a valid version!!" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    const dump = JSON.stringify(body).toLowerCase();
    expect(dump).toContain("dependency_overrides");
    expect(dump).toContain("@x/y");
  });

  test("does not reject a well-formed dependency_overrides value at the value gate", async ({
    apiClient,
    orgContext,
  }) => {
    // A syntactically valid override must pass the value gate. The run proceeds
    // past parsing and fails later for an unrelated reason (no model / no real
    // dep to resolve) — so the ONLY thing asserted is the negative: a 400, if
    // any, must NOT be the dependency_overrides value rejection. Robust across
    // envs (model configured → 202; not → 400 model_not_configured).
    const scope = `@${orgContext.org.orgSlug}`;
    const name = `dep-ov-ok-${Date.now()}`;
    await createAgent(apiClient, scope, name);

    const res = await apiClient.post(`/agents/${scope}/${name}/run`, {
      dependency_overrides: { "@x/y": "^1.2.3" },
    });

    if (res.status() === 400) {
      expect(JSON.stringify(await res.json())).not.toContain("dependency_overrides");
    }
  });

  test("fails loud with 422 for an unsatisfiable manifest pin", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const skillId = `${scope}/dep-skill-${Date.now()}`;
    const agentName = `dep-host-${Date.now()}`;

    // Skill is published at 1.0.0; the agent pins `^9.0.0`, which no published
    // version satisfies. Readiness's `missing_skill` gate passes (the skill id
    // exists in the catalog), so the run reaches the published-only resolver,
    // which must fail loud instead of silently falling back to the draft.
    await createSkill(apiClient, skillId);
    await createAgent(apiClient, scope, agentName, {
      dependencies: { skills: { [skillId]: "^9.0.0" } },
    });

    const res = await apiClient.post(`/agents/${scope}/${agentName}/run`, {});

    expect(res.status()).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("dependency_unresolved");
  });

  test("fails loud with 422 when dependency_overrides forces an unsatisfiable pin", async ({
    apiClient,
    orgContext,
  }) => {
    const scope = `@${orgContext.org.orgSlug}`;
    const skillId = `${scope}/dep-skill-ov-${Date.now()}`;
    const agentName = `dep-host-ov-${Date.now()}`;

    // Agent pins a satisfiable `^1.0.0`; the per-run override forces `^9.0.0`,
    // which no published version satisfies — proving the override path resolves
    // against published versions and fails loud, end to end.
    await createSkill(apiClient, skillId);
    await createAgent(apiClient, scope, agentName, {
      dependencies: { skills: { [skillId]: "^1.0.0" } },
    });

    const res = await apiClient.post(`/agents/${scope}/${agentName}/run`, {
      dependency_overrides: { [skillId]: "^9.0.0" },
    });

    expect(res.status()).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("dependency_unresolved");
  });
});
