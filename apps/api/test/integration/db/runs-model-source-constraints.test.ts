// SPDX-License-Identifier: Apache-2.0

/**
 * `runs.model_source` is the `credential_source` enum, and a remote-origin run
 * records no platform model (`runs_remote_has_no_platform_model`) — so a NULL
 * `model_source` on an event-ingesting run means "remote", by the data rather
 * than by a coercion in the ledger writer.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";

const AGENT = "@modelsource/agent";

async function refusal(promise: Promise<unknown>): Promise<string> {
  const caught = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught, "the statement was expected to be refused by the database").toBeDefined();
  const cause = (caught as { cause?: { message?: string } }).cause;
  return String(cause?.message ?? caught);
}

type RunFields = Omit<Parameters<typeof seedRun>[0], "packageId" | "orgId" | "spaceId">;

describe("runs — model_source and run_origin", () => {
  let ctx: TestContext;
  const run = (fields: RunFields) =>
    seedRun({ packageId: AGENT, orgId: ctx.orgId, spaceId: ctx.defaultSpaceId, ...fields });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "modelsource" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
  });

  it("accepts a launched platform run and a platform run refused before launch", async () => {
    await run({ modelSource: "system", modelId: "preset", inferenceRoute: "proxy" });
    const refused = await run({ status: "failed" });
    expect(refused.modelSource).toBeNull();
  });

  it("accepts a remote run with no platform model", async () => {
    const remote = await run({ runOrigin: "remote" });
    expect(remote.modelSource).toBeNull();
  });

  for (const fields of [
    { modelSource: "org" as const },
    { modelId: "preset" },
    { inferenceRoute: "sidecar" as const },
  ]) {
    it(`refuses a remote run carrying ${Object.keys(fields)[0]}`, async () => {
      expect(await refusal(run({ runOrigin: "remote", ...fields }))).toContain(
        "runs_remote_has_no_platform_model",
      );
    });
  }
});
