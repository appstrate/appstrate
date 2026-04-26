// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `fetchRunConfigPayload` + `mergeRunConfig` — the
 * per-app run-config inheritance the CLI applies between profile
 * resolution and bundle download.
 */

import { describe, it, expect } from "bun:test";
import {
  fetchRunConfigPayload,
  mergeRunConfig,
  RunConfigFetchError,
} from "../src/commands/run/inherit-config.ts";

function stubFetch(opts: {
  status?: number;
  body?: unknown;
  capture?: { url?: string; headers?: Headers };
}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.capture) {
      opts.capture.url = typeof input === "string" ? input : input.toString();
      opts.capture.headers = new Headers(init?.headers);
    }
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("fetchRunConfigPayload", () => {
  it("returns the parsed payload on 200", async () => {
    const fetchImpl = stubFetch({
      body: {
        config: { dryRun: true },
        modelId: "claude-sonnet",
        proxyId: null,
        versionPin: "1.0.0",
        requiredProviders: ["@afps/gmail"],
      },
    });
    const payload = await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      orgId: "org_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(payload?.modelId).toBe("claude-sonnet");
    expect(payload?.versionPin).toBe("1.0.0");
    expect(payload?.requiredProviders).toEqual(["@afps/gmail"]);
  });

  it("returns null on 404 (no inheritance)", async () => {
    const fetchImpl = stubFetch({ status: 404, body: { detail: "not installed" } });
    const payload = await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(payload).toBeNull();
  });

  it("throws on non-2xx, non-404", async () => {
    const fetchImpl = stubFetch({ status: 500, body: { detail: "boom" } });
    await expect(
      fetchRunConfigPayload({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        appId: "app_1",
        scope: "@scope",
        name: "agent",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(RunConfigFetchError);
  });

  it("threads the auth + org + app headers", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({ body: stubPayload(), capture });
    await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      appId: "app_1",
      orgId: "org_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(capture.headers?.get("Authorization")).toBe("Bearer ask_test");
    expect(capture.headers?.get("X-App-Id")).toBe("app_1");
    expect(capture.headers?.get("X-Org-Id")).toBe("org_1");
    expect(capture.url).toContain("/api/applications/app_1/packages/%40scope/agent/run-config");
  });
});

describe("mergeRunConfig — priority order", () => {
  it("flag config shallow-merges over inherited config", () => {
    const merged = mergeRunConfig({
      inherited: {
        config: { dryRun: true, retries: 3 },
        modelId: null,
        proxyId: null,
        versionPin: null,
        requiredProviders: [],
      },
      flagConfig: { retries: 5 },
      hasExplicitSpec: false,
    });
    expect(merged.config).toEqual({ dryRun: true, retries: 5 });
  });

  it("flag model wins over env model wins over inherited model", () => {
    const inherited = {
      config: {},
      modelId: "inherited-model",
      proxyId: null,
      versionPin: null,
      requiredProviders: [],
    };
    expect(mergeRunConfig({ inherited, hasExplicitSpec: false }).modelId).toBe("inherited-model");
    expect(
      mergeRunConfig({ inherited, hasExplicitSpec: false, envModel: "env-model" }).modelId,
    ).toBe("env-model");
    expect(
      mergeRunConfig({
        inherited,
        hasExplicitSpec: false,
        envModel: "env-model",
        flagModel: "flag-model",
      }).modelId,
    ).toBe("flag-model");
  });

  it("explicit spec disables versionPin inheritance", () => {
    const inherited = {
      config: {},
      modelId: null,
      proxyId: null,
      versionPin: "1.2.3",
      requiredProviders: [],
    };
    expect(mergeRunConfig({ inherited, hasExplicitSpec: false }).versionPin).toBe("1.2.3");
    expect(mergeRunConfig({ inherited, hasExplicitSpec: true }).versionPin).toBeNull();
  });

  it("inherited=null produces a no-op merge", () => {
    const merged = mergeRunConfig({ inherited: null, hasExplicitSpec: false });
    expect(merged.inherited).toBe(false);
    expect(merged.config).toEqual({});
    expect(merged.modelId).toBeNull();
    expect(merged.proxyId).toBeNull();
    expect(merged.versionPin).toBeNull();
    expect(merged.requiredProviders).toEqual([]);
  });

  it("requiredProviders flows through unchanged", () => {
    const merged = mergeRunConfig({
      inherited: {
        config: {},
        modelId: null,
        proxyId: null,
        versionPin: null,
        requiredProviders: ["@a/p", "@b/p"],
      },
      hasExplicitSpec: false,
    });
    expect(merged.requiredProviders).toEqual(["@a/p", "@b/p"]);
  });
});

function stubPayload() {
  return {
    config: {},
    modelId: null,
    proxyId: null,
    versionPin: null,
    requiredProviders: [],
  };
}
