// SPDX-License-Identifier: Apache-2.0

/**
 * `createRun` (remote run creation) re-resolves the connection cascade after
 * the route's readiness check. When a connection disappears in between, the
 * refusal is the same structured 409 `missing_integration_connection` the
 * readiness check answers — `errors[]` included — and no `runs` row exists.
 *
 * `createRun` is called directly, which is the race: no readiness pass ran.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { createRun } from "../../../src/services/run-creation.ts";
import { initRunLimits } from "../../../src/services/run-limits.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import {
  inlineAgentManifest,
  seedConnectionTestIntegration,
  seedIntegrationConnection,
} from "../../helpers/run-connection-fixtures.ts";

const AGENT = "@remoteorg/agent";
const INTEG = "@remoteorg/svc";

describe("createRun — connection cascade", () => {
  let ctx: TestContext;
  let agent: LoadedPackage;

  beforeEach(async () => {
    await truncateAll();
    // This file never boots the app; the preflight gates read the limits registry.
    initRunLimits();
    ctx = await createTestContext({ orgSlug: "remoteorg" });
    await seedConnectionTestIntegration(ctx, INTEG);
    const manifest = { ...inlineAgentManifest([INTEG]), name: AGENT };
    await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "agent",
      draftManifest: manifest,
    });
    agent = {
      id: AGENT,
      manifest: manifest as unknown as LoadedPackage["manifest"],
      prompt: "x",
      source: "local",
    };
  });

  function create(runId: string) {
    return createRun({
      runId,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agent,
      input: {},
    });
  }

  it("throws the structured 409 missing_integration_connection and inserts no row", async () => {
    const err = await create("run_missing_connection").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("missing_integration_connection");
    expect(apiError.fieldErrors?.[0]?.field).toBe(`integrations.${INTEG}`);
    expect(await db.select().from(runs).where(eq(runs.packageId, AGENT))).toHaveLength(0);
  });

  it("creates the pending row once the connection exists (control)", async () => {
    await seedIntegrationConnection(ctx, INTEG);

    const result = await create("run_with_connection");

    expect(result.runId).toBe("run_with_connection");
    expect(await db.select().from(runs).where(eq(runs.packageId, AGENT))).toHaveLength(1);
  });
});
