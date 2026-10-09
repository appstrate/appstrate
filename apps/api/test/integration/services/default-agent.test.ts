// SPDX-License-Identifier: Apache-2.0

/**
 * The starter agent a new organization receives is runnable by every surface
 * that executes the latest published version — the CLI's `appstrate run
 * @<scope>/hello-world`, chat, the Claude Code plugin — not only by the
 * dashboard's draft run (#1789).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { validateManifest } from "@appstrate/core/validation";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { provisionDefaultAgentForOrg } from "../../../src/services/default-agent.ts";
import {
  getExactVersionManifest,
  listPackageVersions,
} from "../../../src/services/package-versions.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
import { resolveAgentRunVersion } from "../../../src/services/agent-version-resolver.ts";
import { isPackageActiveHere } from "../../../src/services/space-packages.ts";

describe("provisionDefaultAgentForOrg", () => {
  beforeEach(truncateAll);

  it("publishes 1.0.0, which the latest-published resolver runs, and activates it", async () => {
    const ctx: TestContext = await createTestContext({ orgSlug: "starter-org" });
    const packageId = `@${ctx.org.slug}/hello-world`;

    await provisionDefaultAgentForOrg(ctx.orgId, ctx.org.slug, ctx.user.id, ctx.defaultSpaceId);

    const versions = await listPackageVersions(packageId);
    expect(versions.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(versions[0]!.created_by).toBe(ctx.user.id);
    expect(validateManifest(await getExactVersionManifest(packageId, "1.0.0")).valid).toBe(true);

    const agent = await getPackage(packageId, ctx.orgId);
    expect((await resolveAgentRunVersion(agent!, undefined)).overrideVersionLabel).toBe("1.0.0");
    expect(
      await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, packageId),
    ).toBe(true);
  });
});
