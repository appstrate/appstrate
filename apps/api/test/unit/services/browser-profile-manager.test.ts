// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  BrowserProfileProviderError,
  createBrowserProfileManager,
} from "../../../src/services/browser-profile-manager.ts";

describe("browser profile manager", () => {
  it("uses the attempt as an opaque local process profile", async () => {
    const manager = createBrowserProfileManager({ apiKey: "" });
    expect(
      await manager.allocate({
        provider: "process",
        attemptId: "attempt-id",
        actorRef: "user:secret-id",
      }),
    ).toBe("attempt-id");
  });

  it("allocates and deletes a bounded Browser Use profile without exposing account data", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const profileId = "018f0c67-98ab-7def-8123-123456789abc";
    const manager = createBrowserProfileManager({
      apiKey: "test-browser-use-key-value",
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return init?.method === "POST"
          ? Response.json({ id: profileId }, { status: 201 })
          : new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    expect(
      await manager.allocate({
        provider: "browser-use-cloud",
        attemptId: "018f0c67-98ab-7def-8123-123456789abc",
        actorRef: "user:internal-actor-id",
      }),
    ).toBe(profileId);
    await manager.remove("browser-use-cloud", profileId);
    expect(requests.map((request) => request.init?.method)).toEqual(["POST", "DELETE"]);
    const body = JSON.parse(String(requests[0]?.init?.body)) as { name: string; userId: string };
    expect(body.name).toStartWith("appstrate-");
    expect(body.userId).toBe("user-internal-actor-id");
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({ "X-Browser-Use-API-Key": "test-browser-use-key-value" }),
    );
  });

  it("fails closed on an unconfigured or malformed cloud provider", async () => {
    const unconfigured = createBrowserProfileManager({ apiKey: "" });
    await expect(
      unconfigured.allocate({ provider: "browser-use-cloud", attemptId: "x", actorRef: "user:x" }),
    ).rejects.toBeInstanceOf(BrowserProfileProviderError);
    const malformed = createBrowserProfileManager({
      apiKey: "test-browser-use-key-value",
      fetchFn: (async () =>
        Response.json({ id: "not-a-uuid" }, { status: 201 })) as unknown as typeof fetch,
    });
    await expect(
      malformed.allocate({ provider: "browser-use-cloud", attemptId: "x", actorRef: "user:x" }),
    ).rejects.toThrow(/malformed profile id/);
  });
});
