// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the server-side label derivation helpers exposed by the model-
 * providers cleanup (follow-up to #437). Both `POST /api/models` and
 * `POST /api/model-provider-credentials` accept an optional `label` field
 * and fall back to these helpers when omitted; the connect-helper /
 * `pair/redeem` route relies on `deriveCredentialLabel` for the same
 * reason. The matrix below pins:
 *   1. `displayName` / catalog-label is the base.
 *   2. Subsequent rows get ` (2)`, ` (3)`, … on collision.
 *   3. Unknown providers / models fall back to the literal id.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { deriveCredentialLabel } from "../../../src/services/model-providers/credentials.ts";
import { deriveModelLabel } from "../../../src/services/org-models.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedOrgModel, seedOrgModelProviderKey } from "../../helpers/seed.ts";

describe("deriveCredentialLabel", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "labelorg" });
  });

  it("picks the registry displayName for a known providerId", async () => {
    const label = await deriveCredentialLabel(ctx.orgId, "openai");
    expect(label).toBe("OpenAI");
  });

  it("falls back to the literal providerId for an unknown one", async () => {
    const label = await deriveCredentialLabel(ctx.orgId, "made-up-vendor");
    expect(label).toBe("made-up-vendor");
  });

  it("dedupes against existing org credentials by appending (n)", async () => {
    await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-1",
    });
    expect(await deriveCredentialLabel(ctx.orgId, "openai")).toBe("OpenAI (2)");
    await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI (2)",
      apiShape: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-2",
    });
    expect(await deriveCredentialLabel(ctx.orgId, "openai")).toBe("OpenAI (3)");
  });
});

describe("deriveModelLabel", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "labelorg" });
  });

  it("picks the catalog label when the modelId matches the vendored data", async () => {
    // The vendoring script title-cases the modelId at refresh time, so
    // `gpt-4o` → `"Gpt 4o"`. The exact transform is documented in
    // `scripts/refresh-pricing-catalog.ts`; we only assert that the
    // derived label differs from the raw modelId (i.e. catalog hit).
    const label = await deriveModelLabel(ctx.orgId, "openai", "gpt-4o");
    expect(label).not.toBe("gpt-4o");
    expect(label.toLowerCase()).toContain("4o");
  });

  it("falls back to modelId when the catalog has no entry", async () => {
    expect(await deriveModelLabel(ctx.orgId, "openai", "ft:gpt-4o:my-org:zzz")).toBe(
      "ft:gpt-4o:my-org:zzz",
    );
  });

  it("dedupes against existing org_models rows", async () => {
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      label: "OpenAI",
      apiShape: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    const base = await deriveModelLabel(ctx.orgId, "openai", "gpt-4o");
    await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: base,
      modelId: "gpt-4o",
      enabled: true,
      cost: null,
    });
    const second = await deriveModelLabel(ctx.orgId, "openai", "gpt-4o");
    expect(second).toBe(`${base} (2)`);
  });
});
