// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppstrateCredentialProvider } from "../../../src/providers/credentials/appstrate-provider.ts";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string;
}

interface ServerContext {
  url: string;
  received: CapturedRequest[];
  setResponse: (status: number, body: unknown) => void;
  shutdown: () => void;
}

function startTestServer(): ServerContext {
  const received: CapturedRequest[] = [];
  let status = 200;
  let body: unknown = { credentials: { token: "v" }, authorizedUris: [], allowAllUris: false };

  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      received.push({
        url: url.pathname,
        method: req.method,
        authorization: req.headers.get("authorization") ?? "",
      });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    received,
    setResponse: (s: number, b: unknown) => {
      status = s;
      body = b;
    },
    shutdown: () => server.stop(true),
  };
}

describe("AppstrateCredentialProvider", () => {
  let server: ServerContext;

  beforeEach(() => {
    server = startTestServer();
  });

  afterEach(() => {
    server.shutdown();
  });

  it("GETs /internal/credentials/{providerId} with Bearer auth", async () => {
    server.setResponse(200, {
      credentials: { token: "ghp_xxx" },
      authorizedUris: ["https://api.github.com"],
      allowAllUris: false,
    });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "rt_abc",
    });
    const res = await p.getCredentials("github");

    expect(server.received).toHaveLength(1);
    const req = server.received[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/internal/credentials/github");
    expect(req.authorization).toBe("Bearer rt_abc");

    expect(res.credentials).toEqual({ token: "ghp_xxx" });
    expect(res.authorizedUris).toEqual(["https://api.github.com"]);
    expect(res.allowAllUris).toBeUndefined(); // only set when true
  });

  it("URL-encodes scoped provider ids", async () => {
    server.setResponse(200, {
      credentials: { k: "v" },
      authorizedUris: [],
      allowAllUris: false,
    });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    await p.getCredentials("@scope/provider");

    expect(server.received[0]!.url).toBe("/internal/credentials/%40scope%2Fprovider");
  });

  it("maps authorizedUris: null → empty array", async () => {
    server.setResponse(200, {
      credentials: { k: "v" },
      authorizedUris: null,
      allowAllUris: true,
    });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    const res = await p.getCredentials("x");
    expect(res.authorizedUris).toEqual([]);
    expect(res.allowAllUris).toBe(true);
  });

  it("surfaces platform expiresAt when present", async () => {
    server.setResponse(200, {
      credentials: { k: "v" },
      authorizedUris: [],
      allowAllUris: false,
      expiresAt: 1735689600000,
    });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    expect((await p.getCredentials("x")).expiresAt).toBe(1735689600000);
  });

  it("strips trailing slash from endpoint", async () => {
    const p = new AppstrateCredentialProvider({
      endpoint: `${server.url}/`,
      runToken: "t",
    });
    await p.getCredentials("x");
    expect(server.received[0]!.url).toBe("/internal/credentials/x");
  });

  it("refreshes via POST /internal/credentials/{providerId}/refresh", async () => {
    server.setResponse(200, {
      credentials: { k: "v2" },
      authorizedUris: [],
      allowAllUris: false,
    });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    await p.refresh("github");

    expect(server.received[0]!.method).toBe("POST");
    expect(server.received[0]!.url).toBe("/internal/credentials/github/refresh");
  });

  it("throws a descriptive error on non-2xx, preserving platform detail when available", async () => {
    server.setResponse(403, { detail: "run token expired" });

    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    await expect(p.getCredentials("github")).rejects.toThrow(/403.*run token expired/);
  });

  it("throws cleanly when platform returns 5xx with non-JSON body", async () => {
    server.setResponse(500, "gateway error");
    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    await expect(p.getCredentials("x")).rejects.toThrow(/500/);
  });

  it("throws when the platform response omits credentials", async () => {
    server.setResponse(200, { authorizedUris: [], allowAllUris: false });
    const p = new AppstrateCredentialProvider({
      endpoint: server.url,
      runToken: "t",
    });
    await expect(p.getCredentials("x")).rejects.toThrow(/no credentials/);
  });

  it("rejects construction without endpoint / runToken", () => {
    expect(() => new AppstrateCredentialProvider({ endpoint: "", runToken: "t" })).toThrow(
      /endpoint/,
    );
    expect(() => new AppstrateCredentialProvider({ endpoint: "http://x", runToken: "" })).toThrow(
      /runToken/,
    );
  });
});
