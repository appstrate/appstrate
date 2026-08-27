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
import type { ResolvedRunConfig } from "@appstrate/shared-types";

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
        ...stubPayload(),
        modelId: "claude-sonnet",
        version_pin: "1.0.0",
        generation: { temperature: 0.2 },
        input: { values: { dry_run: true }, locked_fields: ["dry_run"] },
      },
    });
    const payload = await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      orgId: "org_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(payload?.modelId).toBe("claude-sonnet");
    expect(payload?.version_pin).toBe("1.0.0");
    // `generation` and `input` are required members of the wire shape — the
    // endpoint always emits them, and `mergeRunConfig` reads them unguarded.
    expect(payload?.generation).toEqual({ temperature: 0.2 });
    expect(payload?.input).toEqual({ values: { dry_run: true }, locked_fields: ["dry_run"] });
  });

  it("returns null on 404 (no inheritance)", async () => {
    const fetchImpl = stubFetch({ status: 404, body: { detail: "not installed" } });
    const payload = await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
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
        spaceId: "spc_1",
        scope: "@scope",
        name: "agent",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(RunConfigFetchError);
  });

  it("accepts a current payload whose stored input layer is empty", async () => {
    // `{ values: {}, locked_fields: [] }` is what a space with nothing
    // configured emits — the boundary case the refusal below must NOT catch.
    const fetchImpl = stubFetch({ body: stubPayload() });
    const payload = await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(payload?.input).toEqual({ values: {}, locked_fields: [] });
  });

  it("refuses a payload with no `input` member, naming the field and the instance", async () => {
    // `input` first appeared in this payload on 2026-08-21; an instance older
    // than that answers 200 with every other member. The CLI is a published
    // binary pointed at an arbitrary self-hosted platform and has no version
    // handshake, so the cast boundary is the only place that gap can be named
    // — and it must be named, not tolerated (docs/NO_TRANSITIONAL_CODE.md §1).
    const { input: _absentOnOlderServers, ...olderServerPayload } = stubPayload();
    const fetchImpl = stubFetch({ body: olderServerPayload });
    let err: unknown;
    try {
      await fetchRunConfigPayload({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        scope: "@scope",
        name: "agent",
        fetchImpl,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunConfigFetchError);
    expect((err as RunConfigFetchError).message).toContain("`input`");
    expect((err as RunConfigFetchError).message).toContain("https://app.example.com");
    // `formatError` renders `<message> — <hint>`, so the action item the user
    // can take reaches the terminal next to the diagnosis.
    expect((err as RunConfigFetchError).hint).toContain("--no-inherit");
  });

  it("refuses a payload whose `input` members are the wrong shape", async () => {
    const fetchImpl = stubFetch({
      body: { ...stubPayload(), input: { values: {}, locked_fields: "dry_run" } },
    });
    await expect(
      fetchRunConfigPayload({
        instance: "https://app.example.com",
        bearerToken: "ask_test",
        spaceId: "spc_1",
        scope: "@scope",
        name: "agent",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(RunConfigFetchError);
  });

  it("threads the auth + org + space headers", async () => {
    const capture: { url?: string; headers?: Headers } = {};
    const fetchImpl = stubFetch({ body: stubPayload(), capture });
    await fetchRunConfigPayload({
      instance: "https://app.example.com",
      bearerToken: "ask_test",
      spaceId: "spc_1",
      orgId: "org_1",
      scope: "@scope",
      name: "agent",
      fetchImpl,
    });
    expect(capture.headers?.get("Authorization")).toBe("Bearer ask_test");
    expect(capture.headers?.get("X-Space-Id")).toBe("spc_1");
    expect(capture.headers?.get("X-Org-Id")).toBe("org_1");
    // Literal `@` — the Hono server route `:scope{@[^/]+}` rejects
    // `%40scope` as 404. The CLI URL builder leaves scope/name unencoded.
    expect(capture.url).toContain("/api/spaces/spc_1/packages/@scope/agent/run-config");
    expect(capture.url).not.toContain("%40scope");
  });
});

describe("mergeRunConfig — priority order", () => {
  it("flag model wins over env model wins over inherited model", () => {
    const inherited = { ...stubPayload(), modelId: "inherited-model" };
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
    const inherited = { ...stubPayload(), version_pin: "1.2.3" };
    expect(mergeRunConfig({ inherited, hasExplicitSpec: false }).versionPin).toBe("1.2.3");
    expect(mergeRunConfig({ inherited, hasExplicitSpec: true }).versionPin).toBeNull();
  });

  it("passes the generation settings and the stored input layer through", () => {
    const merged = mergeRunConfig({
      inherited: {
        ...stubPayload(),
        generation: { temperature: 0.2 },
        input: { values: { dry_run: true }, locked_fields: ["dry_run"] },
      },
      hasExplicitSpec: false,
    });
    expect(merged.generation).toEqual({ temperature: 0.2 });
    expect(merged.inputValues).toEqual({ dry_run: true });
    expect(merged.lockedInputFields).toEqual(["dry_run"]);
  });

  it("inherited=null produces a no-op merge", () => {
    const merged = mergeRunConfig({ inherited: null, hasExplicitSpec: false });
    expect(merged.inherited).toBe(false);
    expect(merged.modelId).toBeNull();
    expect(merged.proxyId).toBeNull();
    expect(merged.versionPin).toBeNull();
    expect(merged.generation).toBeNull();
    expect(merged.inputValues).toEqual({});
    expect(merged.lockedInputFields).toEqual([]);
  });
});

/** A fully-populated wire payload — every member the endpoint always emits. */
function stubPayload(): ResolvedRunConfig {
  return {
    generation: null,
    modelId: null,
    proxyId: null,
    version_pin: null,
    input: { values: {}, locked_fields: [] },
  };
}
