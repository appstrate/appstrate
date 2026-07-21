// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";

import type { BrowserConnectExecutor } from "../../../src/services/connect/browser-strategy.ts";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  connectToolBlock,
  httpHeaderDelivery,
  localIntegrationManifest,
} from "../../helpers/integration-manifests.ts";
import { seedPackage } from "../../helpers/seed.ts";

const PACKAGE_ID = "@myorg/hosted-browser";

const browserExecutor: BrowserConnectExecutor = {
  async run(execution) {
    await execution.onInteractionRequired?.({
      url: "https://live.browser-use.com/live/hosted-route-test",
    });
    return {
      outputs: { browser_state: '{"cookies":[]}' },
      proof: { kind: "hosted-browser-route-test", succeeded: true },
    };
  },
};

const app = getTestApp({
  modules: [],
  integrationsRouter: { browserConnectExecutor: browserExecutor },
});

function manifest() {
  return localIntegrationManifest({
    name: PACKAGE_ID,
    serverName: "@appstrate/leboncoin-browser",
    auths: {
      session: {
        type: "custom",
        credentialFields: ["browser_state"],
        connect: connectToolBlock({
          tool: "acquire_session",
          runAt: "link",
          produces: ["browser_state"],
          browserExecutor: { sessionMode: "exportable" },
        }),
        delivery: httpHeaderDelivery({ name: "X-Browser-State", field: "browser_state" }),
      },
    },
  });
}

function pageCookie(response: Response): string {
  const match = response.headers.get("set-cookie")?.match(/appstrate_connect=([^;]+)/);
  if (!match) throw new Error("connect page cookie was not set");
  return `appstrate_connect=${match[1]}`;
}

describe("hosted browser connect SSE", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: PACKAGE_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(),
    });
  });

  it("streams the live session before completing and burns the page cookie", async () => {
    const minted = await app.request(
      `/api/integrations/${PACKAGE_ID}/auths/session/connect/session`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(minted.status).toBe(200);
    const { connect_url: connectUrl } = (await minted.json()) as { connect_url: string };
    const token = new URL(connectUrl).searchParams.get("token");
    expect(token).toBeTruthy();

    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token!)}`,
      { redirect: "manual" },
    );
    const cookie = pageCookie(start);
    const contextResponse = await app.request("/api/integrations/connect/context", {
      headers: { Cookie: cookie },
    });
    const context = (await contextResponse.json()) as { csrf: string };

    const submitted = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-connect-csrf": context.csrf,
      },
      body: JSON.stringify({
        credentials: { email: "person@example.test", password: "test-only" },
      }),
    });
    expect(submitted.status).toBe(200);
    expect(submitted.headers.get("content-type")).toContain("text/event-stream");
    expect(submitted.headers.get("cache-control")).toContain("no-store");
    expect(submitted.headers.get("set-cookie")).toContain("Max-Age=0");
    const events = await submitted.text();
    expect(events).toContain("event: interaction");
    expect(events).toContain("https://live.browser-use.com/live/hosted-route-test");
    expect(events).toContain("event: complete");
    expect(events.indexOf("event: interaction")).toBeLessThan(events.indexOf("event: complete"));
  });
});
