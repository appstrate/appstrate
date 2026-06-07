// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the generic resource-server auth-challenge registry +
 * responder. Pure logic over a throwaway Hono app — no DB, no auth pipeline.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../src/types/index.ts";
import {
  registerAuthChallenge,
  resolveAuthChallenge,
  resetAuthChallenges,
  authChallengeResponder,
} from "../../src/lib/auth-challenges.ts";

function appWith(status: number, preset?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", authChallengeResponder());
  app.all("*", (c) => {
    if (preset) c.header("WWW-Authenticate", preset);
    return c.body("x", status as 200);
  });
  return app;
}

describe("auth-challenge registry", () => {
  beforeEach(() => resetAuthChallenges());

  it("resolves a builder for an exact path and a sub-path, but not a sibling", () => {
    registerAuthChallenge("/api/mcp", () => "Bearer x");
    expect(resolveAuthChallenge("/api/mcp")).toBeDefined();
    expect(resolveAuthChallenge("/api/mcp/sub")).toBeDefined();
    expect(resolveAuthChallenge("/api/mcposeur")).toBeUndefined();
    expect(resolveAuthChallenge("/api/other")).toBeUndefined();
  });

  it("prefers the longest matching prefix", () => {
    registerAuthChallenge("/api", () => "broad");
    registerAuthChallenge("/api/mcp", () => "specific");
    expect(resolveAuthChallenge("/api/mcp")!({ origin: "http://x", status: 401 })).toBe("specific");
    expect(resolveAuthChallenge("/api/other")!({ origin: "http://x", status: 401 })).toBe("broad");
  });

  it("re-registering a prefix replaces the builder (idempotent)", () => {
    registerAuthChallenge("/api/mcp", () => "v1");
    registerAuthChallenge("/api/mcp", () => "v2");
    expect(resolveAuthChallenge("/api/mcp")!({ origin: "http://x", status: 401 })).toBe("v2");
  });
});

describe("auth-challenge responder", () => {
  beforeEach(() => resetAuthChallenges());

  it("attaches the challenge to a 401 on a matching path", async () => {
    registerAuthChallenge("/api/mcp", ({ origin, status }) => `Bearer o=${origin} s=${status}`);
    const res = await appWith(401).request("http://inst.test/api/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer o=http://inst.test s=401");
  });

  it("attaches the challenge to a 403 with the 403 status passed through", async () => {
    registerAuthChallenge("/api/mcp", ({ status }) =>
      status === 403 ? "Bearer step-up" : "Bearer plain",
    );
    const res = await appWith(403).request("http://inst.test/api/mcp");
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer step-up");
  });

  it("does not touch non-401/403 responses", async () => {
    registerAuthChallenge("/api/mcp", () => "Bearer x");
    const res = await appWith(200).request("http://inst.test/api/mcp");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("does nothing on an unmatched path", async () => {
    registerAuthChallenge("/api/mcp", () => "Bearer x");
    const res = await appWith(401).request("http://inst.test/api/other");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("never overwrites a challenge a handler already set", async () => {
    registerAuthChallenge("/api/mcp", () => "Bearer registry");
    const res = await appWith(401, "Bearer handler-set").request("http://inst.test/api/mcp");
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer handler-set");
  });

  it("is a no-op when the registry is empty", async () => {
    const res = await appWith(401).request("http://inst.test/api/mcp");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
