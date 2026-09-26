// SPDX-License-Identifier: Apache-2.0

/** `buildChatPlatformDeps`: the one place the enforced-skills read turns a failure into a 503. */

import { describe, expect, it } from "bun:test";
import { ApiError } from "@appstrate/core/api-errors";
import type { ModuleInitContext } from "@appstrate/core/module";
import type { EnforcedChatSkill } from "@appstrate/core/chat-contract";
import { buildChatPlatformDeps } from "../src/platform-services.ts";

function depsOver(
  loadEnforcedChatSkills: (orgId: string, spaceId: string) => Promise<EnforcedChatSkill[]>,
) {
  return buildChatPlatformDeps({
    appUrl: "http://localhost:3000",
    services: { loadEnforcedChatSkills },
  } as unknown as ModuleInitContext);
}

describe("buildChatPlatformDeps — loadEnforcedSkills", () => {
  it("passes the platform's skills through, for the org and space asked", async () => {
    const skill = { packageId: "@acme/house", name: "House", version: "1.0.0", content: "Body." };
    const asked: [string, string][] = [];
    const deps = depsOver(async (orgId, spaceId) => {
      asked.push([orgId, spaceId]);
      return [skill];
    });
    expect(await deps.loadEnforcedSkills("org_1", "spc_1")).toEqual([skill]);
    expect(asked).toEqual([["org_1", "spc_1"]]);
  });

  it("turns a failure into a 503 `enforced_skills_unavailable`, keeping the cause", async () => {
    const cause = new Error("storage outage");
    const deps = depsOver(async () => {
      throw cause;
    });
    const error = await deps.loadEnforcedSkills("org_1", "spc_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "enforced_skills_unavailable" });
    expect((error as ApiError).cause).toBe(cause);
  });

  it("keeps an ApiError cause's detail, which names the skill, in the 503", async () => {
    const deps = depsOver(async () => {
      throw new ApiError({
        status: 422,
        code: "version_artifact_unavailable",
        title: "Unprocessable",
        detail: "Skill '@acme/house' version 1.0.0 cannot be read",
      });
    });
    const error = (await deps
      .loadEnforcedSkills("org_1", "spc_1")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(503);
    expect(error.message).toContain("Skill '@acme/house' version 1.0.0 cannot be read");
    expect(error.message).not.toContain("Retry shortly");
  });

  it("wraps the names read the same way", async () => {
    const deps = buildChatPlatformDeps({
      appUrl: "http://localhost:3000",
      services: {
        listEnforcedChatSkills: async () => {
          throw new Error("database down");
        },
      },
    } as unknown as ModuleInitContext);
    const error = (await deps
      .listEnforcedSkills("org_1", "spc_1")
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: "enforced_skills_unavailable" });
    expect(error.message).toContain("Retry shortly");
  });
});
