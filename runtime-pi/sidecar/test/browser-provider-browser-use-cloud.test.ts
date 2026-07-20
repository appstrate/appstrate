// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  createBrowserUseCloudProvider,
  isAllowedCloudNavigation,
} from "../browser-provider-browser-use-cloud.ts";

const resources = {
  memoryBytes: 1024,
  nanoCpus: 1,
  pidsLimit: 16,
  shmBytes: 1024,
  maxContexts: 1,
  maxPages: 4,
};

const options = {
  runId: "run_cloud_test",
  integrationId: "@appstrate/leboncoin",
  spec: {
    purpose: "connection-acquisition" as const,
    protocol: "cdp-v1" as const,
    profile: "standard" as const,
    allowedOrigins: ["https://www.leboncoin.fr"],
    sessionMode: "exportable" as const,
    trustedDriver: true,
    driverGrantId: "leboncoin",
  },
  egress: { proxyUrl: "http://unused", authToken: "x".repeat(32) },
  resources,
};

describe("Browser Use Cloud provider", () => {
  it("keeps direct cloud navigation on exact manifest origins", () => {
    const allowed = ["https://www.leboncoin.fr"];
    expect(isAllowedCloudNavigation("about:blank", allowed)).toBeTrue();
    expect(
      isAllowedCloudNavigation("https://www.leboncoin.fr/recherche?text=velo", allowed),
    ).toBeTrue();
    expect(isAllowedCloudNavigation("https://auth.leboncoin.fr/login", allowed)).toBeFalse();
    expect(isAllowedCloudNavigation("https://www.leboncoin.fr.evil.test/", allowed)).toBeFalse();
  });

  it("fails preflight without forwarding an absent operator key", async () => {
    const provider = createBrowserUseCloudProvider({ env: {} });
    await expect(provider.prepare("run_cloud_test")).rejects.toThrow(/BROWSER_USE_API_KEY/);
  });

  it("refuses remote cloud execution for ordinary untrusted browser packages", async () => {
    const provider = createBrowserUseCloudProvider({
      env: { BROWSER_USE_API_KEY: "operator-cloud-key-value" },
    });
    await expect(
      provider.spawn({
        ...options,
        spec: {
          ...options.spec,
          purpose: "automation",
          trustedDriver: false,
          driverGrantId: undefined,
        },
      }),
    ).rejects.toThrow(/restricted to trusted connection drivers/);
  });

  it("keeps the cloud authority behind a local per-run bearer broker", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === "POST") {
        return Response.json(
          {
            id: "018f0c67-98ab-7def-8123-123456789abc",
            status: "active",
            cdpUrl: "https://018f0c67.cdp.browser-use.com",
            liveUrl: "https://live.browser-use.com/live/public-id",
            timeoutAt: new Date(Date.now() + 60_000).toISOString(),
            startedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }
      if (init?.method === "GET") {
        return Response.json({
          webSocketDebuggerUrl: "wss://connect.browser-use.com/devtools?token=cloud-secret",
        });
      }
      return Response.json({ status: "stopped" }, { status: 200 });
    }) as typeof fetch;
    const provider = createBrowserUseCloudProvider({
      env: {
        BROWSER_USE_API_KEY: "operator-cloud-key-value",
        BROWSER_USE_CLOUD_PROXY_COUNTRY: "fr",
        BROWSER_USE_CLOUD_TIMEOUT_MINUTES: "15",
      },
      fetchFn,
    });
    await provider.prepare("run_cloud_test");
    const handle = await provider.spawn(options);
    expect(handle.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.endpoint).not.toContain("cloud-secret");
    expect(handle.authToken).not.toBe("operator-cloud-key-value");
    expect(handle.interactionUrl).toBe("https://live.browser-use.com/live/public-id");
    const unauthorized = await fetch(`${handle.endpoint}/json/version`);
    expect(unauthorized.status).toBe(401);
    const discovery = await fetch(`${handle.endpoint}/json/version`, {
      headers: { Authorization: `Bearer ${handle.authToken}` },
    });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ Browser: "Browser Use Cloud" });
    const context = await fetch(`${handle.endpoint}/v1/context`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.authToken}` },
    });
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({
      defaultContext: true,
      fileUploadMode: "unsupported",
      captchaSolver: true,
    });
    await provider.stop(handle);

    expect(requests).toHaveLength(3);
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({ "X-Browser-Use-API-Key": "operator-cloud-key-value" }),
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      timeout: 15,
      proxyCountryCode: "fr",
    });
    expect(requests[1]?.url).toBe("https://018f0c67.cdp.browser-use.com/json/version");
    expect(requests[1]?.init?.method).toBe("GET");
    expect(requests[2]?.init?.method).toBe("PATCH");
  });

  it("uses one operator profile through an authenticated custom proxy", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === "POST") {
        return Response.json(
          {
            id: "018f0c67-98ab-7def-8123-123456789abc",
            status: "active",
            cdpUrl: "https://018f0c67.cdp.browser-use.com",
            liveUrl: "https://live.browser-use.com/live/public-id",
          },
          { status: 201 },
        );
      }
      if (init?.method === "GET") {
        return Response.json({
          webSocketDebuggerUrl: "wss://connect.browser-use.com/devtools?token=cloud-secret",
        });
      }
      return Response.json({ status: "stopped" });
    }) as typeof fetch;
    const provider = createBrowserUseCloudProvider({
      env: {
        BROWSER_USE_API_KEY: "operator-cloud-key-value",
        BROWSER_USE_CLOUD_TIMEOUT_MINUTES: "20",
        BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST: "residential-proxy.example",
        BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT: "8443",
        BROWSER_USE_CLOUD_CUSTOM_PROXY_USERNAME: "proxy-user",
        BROWSER_USE_CLOUD_CUSTOM_PROXY_PASSWORD: "proxy-password",
        BROWSER_USE_CLOUD_PROFILE_ID: "018f0c67-98ab-7def-8123-123456789abc",
      },
      fetchFn,
    });

    await provider.prepare("run_cloud_test");
    const handle = await provider.spawn(options);
    await provider.stop(handle);

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      timeout: 20,
      customProxy: {
        host: "residential-proxy.example",
        port: 8443,
        username: "proxy-user",
        password: "proxy-password",
        ignoreCertErrors: false,
      },
      profileId: "018f0c67-98ab-7def-8123-123456789abc",
    });
  });

  it("uses the connection-scoped profile instead of the legacy operator profile", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === "POST") {
        return Response.json(
          {
            id: "018f0c67-98ab-7def-8123-123456789abc",
            cdpUrl: "https://018f0c67.cdp.browser-use.com",
            liveUrl: null,
          },
          { status: 201 },
        );
      }
      if (init?.method === "GET") {
        return Response.json({
          webSocketDebuggerUrl: "wss://connect.browser-use.com/devtools?token=cloud-secret",
        });
      }
      return Response.json({ status: "stopped" });
    }) as typeof fetch;
    const provider = createBrowserUseCloudProvider({
      env: {
        BROWSER_USE_API_KEY: "operator-cloud-key-value",
        BROWSER_USE_CLOUD_PROFILE_ID: "018f0c67-98ab-7def-8123-123456789abc",
      },
      fetchFn,
    });
    const bindingProfile = "019f0c67-98ab-7def-8123-123456789abc";
    const handle = await provider.spawn({
      ...options,
      spec: {
        ...options.spec,
        providerBinding: {
          bindingId: "029f0c67-98ab-7def-8123-123456789abc",
          provider: "browser-use-cloud",
          profileRef: bindingProfile,
          stateVersion: 4,
          proxy: { kind: "country", countryCode: "de" },
        },
      },
    });
    await provider.stop(handle);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      profileId: bindingProfile,
      proxyCountryCode: "de",
    });
  });

  it("rejects partial, ambiguous, or malformed operator cloud routing", () => {
    expect(() =>
      createBrowserUseCloudProvider({
        env: {
          BROWSER_USE_API_KEY: "operator-cloud-key-value",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST: "proxy.example",
        },
      }),
    ).toThrow(/valid host and port/);
    expect(() =>
      createBrowserUseCloudProvider({
        env: {
          BROWSER_USE_API_KEY: "operator-cloud-key-value",
          BROWSER_USE_CLOUD_PROXY_COUNTRY: "fr",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST: "proxy.example",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT: "8080",
        },
      }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      createBrowserUseCloudProvider({
        env: {
          BROWSER_USE_API_KEY: "operator-cloud-key-value",
          BROWSER_USE_CLOUD_PROFILE_ID: "not-a-profile-id",
        },
      }),
    ).toThrow(/must be a UUID/);
    expect(() =>
      createBrowserUseCloudProvider({
        env: {
          BROWSER_USE_API_KEY: "operator-cloud-key-value",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST: "proxy.example",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT: "70000",
        },
      }),
    ).toThrow(/integer from 1 to 65535/);
    expect(() =>
      createBrowserUseCloudProvider({
        env: {
          BROWSER_USE_API_KEY: "operator-cloud-key-value",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_HOST: "proxy.example",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_PORT: "8080",
          BROWSER_USE_CLOUD_CUSTOM_PROXY_USERNAME: "proxy-user",
        },
      }),
    ).toThrow(/must be set together/);
  });

  it("rejects unsafe cloud CDP endpoints and stops the paid session", async () => {
    const methods: string[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        return Response.json(
          {
            id: "018f0c67-98ab-7def-8123-123456789abc",
            cdpUrl: "https://attacker.example/devtools",
            liveUrl: null,
          },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 200 });
    }) as typeof fetch;
    const provider = createBrowserUseCloudProvider({
      env: { BROWSER_USE_API_KEY: "operator-cloud-key-value" },
      fetchFn,
    });
    await expect(provider.spawn(options)).rejects.toThrow(/unsafe CDP URL/);
    expect(methods).toEqual(["POST", "PATCH"]);
  });

  it("rejects unsafe live-view URLs and stops the paid session", async () => {
    const methods: string[] = [];
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        return Response.json(
          {
            id: "018f0c67-98ab-7def-8123-123456789abc",
            cdpUrl: "https://018f0c67.cdp.browser-use.com",
            liveUrl: "https://browser-use.com.attacker.example/live/session",
          },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 200 });
    }) as typeof fetch;
    const provider = createBrowserUseCloudProvider({
      env: { BROWSER_USE_API_KEY: "operator-cloud-key-value" },
      fetchFn,
    });
    await expect(provider.spawn(options)).rejects.toThrow(/unsafe live URL/);
    expect(methods).toEqual(["POST", "PATCH"]);
  });
});
