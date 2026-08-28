// SPDX-License-Identifier: Apache-2.0

/**
 * An aliased run must not name the credential that backs its model.
 *
 * `runs.model_credential_id` is emitted by the run DTO (`services/state/runs.ts`)
 * to every dashboard user who can read the run. On an ALIASED model that id is
 * a cross-reference: `GET /api/model-provider-credentials` serves
 * `available_model_ids` per credential, so the id de-anonymises the alias and
 * names the backing vendor and model — exactly what the alias exists to hide
 * (issue #727, Threat A).
 *
 * The masking is a WRITE-time null (`services/run-pipeline.ts`) with no
 * read-side guard behind it, so nothing downstream would notice it stopping.
 * Both halves are asserted here: the alias is masked, and the plain model —
 * the identical launch minus the `aliased` flag — still carries its id, so a
 * blanket `null` cannot pass for a working mask either.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

describe("run launch — model_credential_id on an aliased model", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "alias-cred" });
  });

  // The trigger is fire-and-forget; drain here so a failing assertion cannot
  // leave background writes racing the next truncate.
  afterEach(waitForRunPipelineSettled);

  /** Make an org-default model on a real api_key credential. Returns its id. */
  async function seedDefaultModel(aliased: boolean): Promise<string> {
    const credentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Backing credential",
      providerId: "openai",
      apiKey: "sk-test-not-a-real-key",
    });
    const modelDbId = await createOrgModel(
      ctx.orgId,
      aliased ? "Appstrate Medium" : "Plain GPT",
      "gpt-5.5",
      ctx.user.id,
      credentialId,
      { aliased },
    );
    await setDefaultModel(ctx.orgId, modelDbId);
    return credentialId;
  }

  /** Launch an inline run and read it back through the public detail route. */
  async function launchAndRead(): Promise<{ modelCredentialId: string | null }> {
    const res = await app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: inlineAgentManifest(), prompt: "do the thing" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const detail = await app.request(`/api/runs/${id}`, { headers: authHeaders(ctx) });
    expect(detail.status).toBe(200);
    return (await detail.json()) as { modelCredentialId: string | null };
  }

  it("does not serve the backing credential id for an aliased model", async () => {
    await seedDefaultModel(true);
    expect((await launchAndRead()).modelCredentialId).toBeNull();
  });

  it("still serves the credential id for a plain, non-aliased model (control)", async () => {
    const credentialId = await seedDefaultModel(false);
    expect((await launchAndRead()).modelCredentialId).toBe(credentialId);
  });
});
