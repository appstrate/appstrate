// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { getScopedEndUserId } from "../../src/lib/end-user-scope.ts";
import type { AppEnv } from "../../src/types/index.ts";

function createContext(endUser?: { id: string; role: string }) {
  const app = new Hono<AppEnv>();
  let result: string | null = "NOT_SET";

  app.get("/test", (c) => {
    if (endUser) {
      c.set("endUser", {
        id: endUser.id,
        applicationId: "app_test",
        name: "Test",
        email: "test@example.com",
        role: endUser.role,
      });
    }
    result = getScopedEndUserId(c);
    return c.text("ok");
  });

  return { app, getResult: () => result };
}

describe("getScopedEndUserId", () => {
  it("returns null when no endUser in context (session/API key auth)", async () => {
    const { app, getResult } = createContext();
    await app.request("/test");
    expect(getResult()).toBeNull();
  });

  it("returns null when endUser role is admin", async () => {
    const { app, getResult } = createContext({ id: "eu_admin", role: "admin" });
    await app.request("/test");
    expect(getResult()).toBeNull();
  });

  it("returns endUser.id when role is member", async () => {
    const { app, getResult } = createContext({ id: "eu_member", role: "member" });
    await app.request("/test");
    expect(getResult()).toBe("eu_member");
  });

  it("returns endUser.id when role is viewer", async () => {
    const { app, getResult } = createContext({ id: "eu_viewer", role: "viewer" });
    await app.request("/test");
    expect(getResult()).toBe("eu_viewer");
  });
});
