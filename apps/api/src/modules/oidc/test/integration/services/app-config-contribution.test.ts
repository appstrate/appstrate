// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the OIDC module's `appConfigContribution()` hook.
 *
 * Verifies that after the instance client is auto-provisioned, the hook
 * returns the OIDC config (clientId + issuer) that gets merged into AppConfig
 * and served to the SPA via `window.__APP_CONFIG__`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { _resetCacheForTesting, getEnv } from "@appstrate/env";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import oidcModule from "../../../index.ts";

const originalAppUrl = process.env.APP_URL;

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  _resetCacheForTesting();
});

afterAll(() => {
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
  _resetCacheForTesting();
});

describe("appConfigContribution", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns empty when no instance client exists", async () => {
    const result = await oidcModule.appConfigContribution!();
    expect(result).toEqual({});
  });

  it("returns oidc config after instance client is provisioned", async () => {
    const { ensureInstanceClient } = await import("../../../services/oauth-admin.ts");
    const clientId = await ensureInstanceClient("http://localhost:3000");

    const result = await oidcModule.appConfigContribution!();
    const env = getEnv();

    expect(result).toEqual({
      oidc: {
        clientId,
        issuer: `${env.APP_URL}/api/auth`,
      },
    });
  });

  it("clientId in config matches the provisioned instance client", async () => {
    const { ensureInstanceClient, getInstanceClientId } =
      await import("../../../services/oauth-admin.ts");
    await ensureInstanceClient("http://localhost:3000");

    const result = (await oidcModule.appConfigContribution!()) as {
      oidc?: { clientId: string; issuer: string };
    };
    const dbClientId = await getInstanceClientId();

    expect(result.oidc).toBeDefined();
    expect(result.oidc!.clientId).toBe(dbClientId!);
  });
});
