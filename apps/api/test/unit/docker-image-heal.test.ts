// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring check for the pull-on-missing-image path in `docker.ts`.
 *
 * `docker-errors.test.ts` covers the classifier and the recovery helper in
 * isolation; this file covers the part that actually broke production — that
 * `createContainer` routes through them, against a stand-in Docker Engine
 * speaking the real wire contract (status codes + body shapes).
 *
 * `docker.ts` captures `DOCKER_SOCKET` at module load, so the fake daemon's
 * address is installed *before* a cache-busted dynamic import, then restored
 * immediately — the fake address survives only inside that one module copy.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";

interface DockerModule {
  createContainer: (
    runId: string,
    envVars: Record<string, string>,
    options: { image: string; adapterName: string },
  ) => Promise<string>;
}

const IMAGE = "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.40";
const MISSING_IMAGE_BODY = JSON.stringify({ message: `No such image: ${IMAGE}` });
const UNKNOWN_NETWORK_BODY = JSON.stringify({ message: "network appstrate-egress not found" });

/** Mutable fake-daemon state, reset per test. */
const state = {
  createCalls: 0,
  pullCalls: 0,
  imagePresent: false,
  /** When set, every create answers this 404 instead of the image one. */
  createFailure: null as string | null,
  /** Delay applied to a pull, so the coalescing window is real. */
  pullDelayMs: 0,
};

let server: ReturnType<typeof Bun.serve>;
let docker: DockerModule;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/containers/create") {
        state.createCalls += 1;
        if (state.createFailure) return new Response(state.createFailure, { status: 404 });
        if (!state.imagePresent) return new Response(MISSING_IMAGE_BODY, { status: 404 });
        return new Response(JSON.stringify({ Id: "ctr-healed" }), { status: 201 });
      }
      if (pathname === "/images/create") {
        state.pullCalls += 1;
        if (state.pullDelayMs) await Bun.sleep(state.pullDelayMs);
        state.imagePresent = true;
        // Docker streams newline-delimited JSON progress and always 200s.
        return new Response(`{"status":"Downloaded"}\n`, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  });

  const previous = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = `http://localhost:${server.port}`;
  _resetCacheForTesting();
  // Variable specifier: keeps the cache-busting query out of TS module
  // resolution. A distinct specifier gives a fresh module copy, so the
  // fake address cannot leak into any other test's `docker.ts`.
  const specifier = "../../src/services/docker.ts?fake-daemon";
  docker = (await import(specifier)) as DockerModule;

  if (previous === undefined) delete process.env.DOCKER_SOCKET;
  else process.env.DOCKER_SOCKET = previous;
  _resetCacheForTesting();
});

afterAll(() => {
  server.stop(true);
});

function reset(overrides: Partial<typeof state> = {}) {
  Object.assign(state, {
    createCalls: 0,
    pullCalls: 0,
    imagePresent: false,
    createFailure: null,
    pullDelayMs: 0,
    ...overrides,
  });
}

describe("createContainer pull-on-missing-image wiring", () => {
  it("heals an image pruned from under a long-lived process", async () => {
    reset();
    const id = await docker.createContainer("run_1", {}, { image: IMAGE, adapterName: "agent" });
    expect(id).toBe("ctr-healed");
    expect(state.createCalls).toBe(2); // initial miss + retry after pull
    expect(state.pullCalls).toBe(1);
  });

  it("does not pull when the image is already present", async () => {
    reset({ imagePresent: true });
    await docker.createContainer("run_2", {}, { image: IMAGE, adapterName: "agent" });
    expect(state.createCalls).toBe(1);
    expect(state.pullCalls).toBe(0);
  });

  it("coalesces concurrent misses onto a single pull", async () => {
    // The heal itself creates this scenario: a prune makes every queued run
    // miss at the same moment.
    reset({ pullDelayMs: 100 });
    const ids = await Promise.all(
      ["a", "b", "c"].map((n) =>
        docker.createContainer(`run_${n}`, {}, { image: IMAGE, adapterName: "agent" }),
      ),
    );
    expect(ids).toEqual(["ctr-healed", "ctr-healed", "ctr-healed"]);
    expect(state.pullCalls).toBe(1);
  });

  it("surfaces an unrelated 404 verbatim, without retrying or pulling", async () => {
    // Also proves the helper's `clone()` left the body readable downstream.
    reset({ createFailure: UNKNOWN_NETWORK_BODY });
    await expect(
      docker.createContainer("run_3", {}, { image: IMAGE, adapterName: "agent" }),
    ).rejects.toThrow(/network appstrate-egress not found/);
    expect(state.createCalls).toBe(1);
    expect(state.pullCalls).toBe(0);
  });
});
