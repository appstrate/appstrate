// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Db } from "@appstrate/db/client";
import { forceRefresh, RefreshError, type RefreshContext } from "../src/token-refresh.ts";
import { encryptCredentials } from "../src/encryption.ts";

// A stub db that throws if anything attempts to touch it.
// All failure cases must throw BEFORE the success path that writes to the DB.
const stubDb = new Proxy(
  {},
  {
    get() {
      throw new Error("stubDb should not be called on failure paths");
    },
  },
) as unknown as Db;

const encryptedCreds = encryptCredentials({
  access_token: "old_access",
  refresh_token: "old_refresh",
});

const ctx: RefreshContext = {
  tokenUrl: "https://oauth.example.com/token",
  clientId: "client_id",
  clientSecret: "client_secret",
};

const originalFetch = globalThis.fetch;

function mockFetchOnce(response: Response | Promise<Response> | (() => never)) {
  globalThis.fetch = mock(async () => {
    if (typeof response === "function") response();
    return response as Response;
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

describe("forceRefresh — error classification", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── "revoked" cases (flag needsReconnection) ─────────────────

  it('400 + {"error":"invalid_grant"} → kind = "revoked"', async () => {
    mockFetchOnce(jsonResponse(400, { error: "invalid_grant" }));

    try {
      await forceRefresh(stubDb, "conn_1", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).kind).toBe("revoked");
      expect((err as RefreshError).status).toBe(400);
    }
  });

  it('400 + {"error":"invalid_grant","error_description":"..."} (Google format) → "revoked"', async () => {
    mockFetchOnce(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );

    try {
      await forceRefresh(stubDb, "conn_2", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).kind).toBe("revoked");
    }
  });

  // ── "transient" cases (do NOT flag) ──────────────────────────

  it('400 + {"error":"invalid_client"} → "transient" (config problem, not dead credential)', async () => {
    mockFetchOnce(jsonResponse(400, { error: "invalid_client" }));

    try {
      await forceRefresh(stubDb, "conn_3", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).kind).toBe("transient");
    }
  });

  it('400 + {"error":"invalid_scope"} → "transient"', async () => {
    mockFetchOnce(jsonResponse(400, { error: "invalid_scope" }));

    try {
      await forceRefresh(stubDb, "conn_4", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
    }
  });

  it("400 with non-JSON body → transient", async () => {
    mockFetchOnce(textResponse(400, "Bad Request"));

    try {
      await forceRefresh(stubDb, "conn_5", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
    }
  });

  it("400 + JSON body without error field → transient", async () => {
    mockFetchOnce(jsonResponse(400, { message: "something went wrong" }));

    try {
      await forceRefresh(stubDb, "conn_6", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
    }
  });

  it('401 + {"error":"invalid_grant"} → transient (status must be 400)', async () => {
    mockFetchOnce(jsonResponse(401, { error: "invalid_grant" }));

    try {
      await forceRefresh(stubDb, "conn_7", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
      expect((err as RefreshError).status).toBe(401);
    }
  });

  it("500 → transient", async () => {
    mockFetchOnce(textResponse(500, "Internal Server Error"));

    try {
      await forceRefresh(stubDb, "conn_8", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
      expect((err as RefreshError).status).toBe(500);
    }
  });

  it("502 → transient", async () => {
    mockFetchOnce(textResponse(502, "Bad Gateway"));

    try {
      await forceRefresh(stubDb, "conn_9", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as RefreshError).kind).toBe("transient");
    }
  });

  it("network error (fetch throws) → transient", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await forceRefresh(stubDb, "conn_10", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).kind).toBe("transient");
      expect((err as RefreshError).status).toBeUndefined();
    }
  });

  it("200 with non-JSON body → transient (success but unparseable)", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    try {
      await forceRefresh(stubDb, "conn_11", "prov", encryptedCreds, ctx);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).kind).toBe("transient");
    }
  });
});

describe("forceRefresh — no refresh context", () => {
  it("returns current credentials when refreshContext is omitted", async () => {
    const result = await forceRefresh(stubDb, "conn_noctx", "prov", encryptedCreds);
    expect(result.access_token).toBe("old_access");
    expect(result.refresh_token).toBe("old_refresh");
  });
});
