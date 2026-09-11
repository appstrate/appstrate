// SPDX-License-Identifier: Apache-2.0

/**
 * The inline run path resolves its integration pins ONCE.
 *
 * `runInlinePreflight` seeds a manifest memo with the PINNED integration
 * manifests (`resolveRunIntegrationVersions`) and judges its selection checks
 * and its readiness pass against it. It returns that memo, and
 * `triggerInlineRun` hands it to `prepareAndExecuteRun` — the same one-Map
 * discipline the registered-agent route applies across `resolveRunPreflight`
 * and the kickoff (`routes/runs.ts`). Before that, the kickoff created a fresh
 * Map and every pin was resolved a second time.
 *
 * Threading is invisible in the run's VERDICT (Step 2a re-freezes the same
 * versions either way), so the assertion is on identity: the memo handed to
 * `triggerInlineRun` is the one the pipeline writes into. A recording Map makes
 * that observable without touching the production call graph.
 */

import { describe, it, expect, beforeEach } from "bun:test";
// Imported for its module-level boot: this suite calls the services directly,
// and they read singletons (`initRunLimits`, the model/proxy registries) that
// only the app helper initialises.
import "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  inlineAgentManifest,
  seedConnectionTestIntegration,
  seedIntegrationConnection,
} from "../../helpers/run-connection-fixtures.ts";
import { runInlinePreflight } from "../../../src/services/inline-run-preflight.ts";
import { triggerInlineRun } from "../../../src/services/inline-run.ts";
import type { IntegrationManifestCache } from "../../../src/services/integration-service.ts";
import type { IntegrationManifestLoadResult } from "../../../src/services/integration-service.ts";
import { ApiError } from "../../../src/lib/errors.ts";

const INTEGRATION = "@inlinememo/svc";

/** A `Map` that records the keys written into it. */
class RecordingCache extends Map<string, Promise<IntegrationManifestLoadResult>> {
  readonly written: string[] = [];
  override set(key: string, value: Promise<IntegrationManifestLoadResult>): this {
    this.written.push(key);
    return super.set(key, value);
  }
}

describe("inline run — one manifest memo across preflight and kickoff", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlinememo" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
  });

  async function preflight() {
    return runInlinePreflight({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      body: { manifest: inlineAgentManifest([INTEGRATION]), prompt: "do the thing" },
      authorizeDependencies: async () => {},
    });
  }

  it("returns the memo it seeded with the pinned integration manifests", async () => {
    const result = await preflight();
    // Seeded, not merely present: the pin `^1.0.0` resolved to the published
    // 1.0.0 and its manifest is what stages 1b and 3 judged.
    expect(result.manifestCache.has(INTEGRATION)).toBe(true);
    await expect(result.manifestCache.get(INTEGRATION)!).resolves.toMatchObject({ ok: true });
  });

  it("hands that memo to the kickoff instead of letting it build its own", async () => {
    const recording = new RecordingCache();
    const result = { ...(await preflight()), manifestCache: recording as IntegrationManifestCache };
    expect(recording.written).toEqual([]);

    // The org has no LLM model, so the pipeline reaches Step 3 and stops there
    // with `model_not_configured` — after Step 2a, which is the write we are
    // watching for. Asserting the code is the positive anchor: without it, an
    // earlier failure would leave `written` empty and read as a regression.
    let code: string | undefined;
    try {
      await triggerInlineRun({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        actor: { type: "user", id: ctx.user.id },
        runId: `run_${crypto.randomUUID()}`,
        preflight: result,
        parsed: {},
      });
    } catch (err) {
      code = err instanceof ApiError ? err.code : String(err);
    }
    expect(code).toBe("model_not_configured");

    // Step 2a's freeze seeded THIS Map — proof the kickoff received it rather
    // than resolving the same pin into a Map of its own.
    expect(recording.written).toContain(INTEGRATION);
  });
});
