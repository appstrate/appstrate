// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { postImport, ImportRequestError } from "../src/import-client.ts";

const realFetch = globalThis.fetch;

function mockFetch(handler: (req: Request) => Response | Promise<Response>): void {
  const stub = ((input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    return Promise.resolve(handler(req));
  }) as typeof fetch;
  globalThis.fetch = stub;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("postImport", () => {
  let captured: { url: string; bearer: string; body: Record<string, unknown> } | null = null;

  beforeEach(() => {
    captured = null;
  });

  it("POSTs to /api/model-providers-oauth/import with Bearer auth", async () => {
    mockFetch(async (req) => {
      captured = {
        url: req.url,
        bearer: req.headers.get("authorization") ?? "",
        body: (await req.json()) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          providerKeyId: "mp_xyz",
          connectionId: "con_xyz",
          providerId: "codex",
          availableModelIds: ["gpt-4o"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await postImport({
      platformUrl: "https://app.appstrate.dev",
      bearer: "appp_xxx.yyy",
      providerId: "codex",
      label: "Personal",
      credentials: {
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: 12345,
        email: "user@example.com",
        accountId: "uuid-here",
      },
    });

    expect(captured?.url).toBe("https://app.appstrate.dev/api/model-providers-oauth/import");
    expect(captured?.bearer).toBe("Bearer appp_xxx.yyy");
    expect(captured?.body.providerId).toBe("codex");
    expect(captured?.body.label).toBe("Personal");
    expect(captured?.body.accessToken).toBe("acc");
    expect(captured?.body.refreshToken).toBe("ref");
    expect(captured?.body.expiresAt).toBe(12345);
    expect(captured?.body.email).toBe("user@example.com");
    expect(captured?.body.accountId).toBe("uuid-here");
    expect(result.providerKeyId).toBe("mp_xyz");
    expect(result.availableModelIds).toEqual(["gpt-4o"]);
  });

  it("strips trailing slashes from platformUrl", async () => {
    mockFetch(async (req) => {
      captured = { url: req.url, bearer: "", body: {} };
      return new Response(
        JSON.stringify({
          providerKeyId: "x",
          connectionId: "y",
          providerId: "codex",
          availableModelIds: [],
        }),
      );
    });
    await postImport({
      platformUrl: "https://app.appstrate.dev///",
      bearer: "appp_xxx.yyy",
      providerId: "codex",
      label: "x",
      credentials: { accessToken: "a", refreshToken: "r", expiresAt: 0 },
    });
    expect(captured?.url).toBe("https://app.appstrate.dev/api/model-providers-oauth/import");
  });

  it("omits expiresAt when 0 (provider didn't surface it)", async () => {
    mockFetch(async (req) => {
      captured = {
        url: req.url,
        bearer: "",
        body: (await req.json()) as Record<string, unknown>,
      };
      return new Response(
        JSON.stringify({
          providerKeyId: "x",
          connectionId: "y",
          providerId: "codex",
          availableModelIds: [],
        }),
      );
    });
    await postImport({
      platformUrl: "https://app.appstrate.dev",
      bearer: "appp_xxx.yyy",
      providerId: "codex",
      label: "x",
      credentials: { accessToken: "a", refreshToken: "r", expiresAt: 0 },
    });
    expect(captured?.body.expiresAt).toBeNull();
  });

  it("throws ImportRequestError with structured detail on 410 (expired pairing)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: 410,
            code: "pairing_expired",
            title: "Gone",
            detail: "This pairing token has expired.",
          }),
          { status: 410, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      postImport({
        platformUrl: "https://app.appstrate.dev",
        bearer: "appp_xxx.yyy",
        providerId: "codex",
        label: "x",
        credentials: { accessToken: "a", refreshToken: "r", expiresAt: 0 },
      }),
    ).rejects.toBeInstanceOf(ImportRequestError);
  });

  it("uses statusText fallback when error body is not JSON", async () => {
    mockFetch(
      () => new Response("internal kaboom", { status: 500, statusText: "Internal Server Error" }),
    );
    try {
      await postImport({
        platformUrl: "https://app.appstrate.dev",
        bearer: "appp_xxx.yyy",
        providerId: "codex",
        label: "x",
        credentials: { accessToken: "a", refreshToken: "r", expiresAt: 0 },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportRequestError);
      const r = (err as ImportRequestError).response;
      expect(r.status).toBe(500);
      expect(r.code).toBe("HTTP_500");
    }
  });
});
