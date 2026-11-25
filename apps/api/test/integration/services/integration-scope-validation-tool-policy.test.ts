// SPDX-License-Identifier: Apache-2.0

/**
 * The space's approved tools count as known tool names when an agent's selection is validated,
 * but only the ones the policy still stands behind: an approval recorded before the manifest hid
 * (or declared) the tool counts for nothing.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedProxyIntegration } from "../../helpers/credential-proxy-fixtures.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { insertToolApprovals } from "../../helpers/tool-policy.ts";
import { validateAgentIntegrationSelections } from "../../../src/services/integration-scope-validation.ts";

const ID = "@acme/files";

const agent = (tools: string[]) => ({
  schema_version: "0.2",
  type: "agent",
  name: "@acme/agent",
  version: "0.1.0",
  display_name: "Agent",
  dependencies: { integrations: { [ID]: "^1.0.0" } },
  integrations_configuration: { [ID]: { tools } },
});

describe("validateAgentIntegrationSelections — approved tools", () => {
  let ctx: TestContext;

  const unknownTools = async () =>
    (
      await validateAgentIntegrationSelections({
        manifest: agent(["write_file"]),
        orgId: ctx.orgId,
        toolPolicySpaceId: ctx.defaultSpaceId,
      })
    ).filter((error) => error.code === "unknown_tool");

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "acme" });
  });

  const approveWrite = () =>
    insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: ID }, [
      { toolName: "write_file", fingerprint: "a".repeat(64) },
    ]);

  it("knows an undeclared tool the space approved", async () => {
    await seedProxyIntegration(
      ctx,
      remoteIntegrationManifest({ name: ID, tools_policy: { read_file: {} } }),
    );
    await approveWrite();
    expect(await unknownTools()).toEqual([]);
  });

  it("does not know an approved tool the manifest has since hidden", async () => {
    await seedProxyIntegration(ctx, {
      ...remoteIntegrationManifest({
        name: ID,
        tools_policy: { read_file: {}, write_file: {} },
      }),
      hidden_tools: ["write_file"],
    });
    await approveWrite();
    expect(await unknownTools()).toHaveLength(1);
  });
});
