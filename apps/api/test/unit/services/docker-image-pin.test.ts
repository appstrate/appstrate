// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-image pin reconciliation, driven against a stubbed Docker Engine
 * (#1521).
 *
 * What matters here — the config a pin is created with, and whether a pass
 * leaves an existing pin alone or replaces it — is decided from the inspect
 * payload and the create body, not from anything a real daemon does.
 * `apps/api/test/integration/services/docker-api.test.ts` covers the same
 * ground against a live daemon, but those cases are gated behind
 * `TEST_DOCKER=1` and no workflow sets it, so CI would otherwise verify none
 * of this. Stubbing `fetch` keeps the decision under test at tier 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureImagePin, IMAGE_PIN_PREFIX } from "../../../src/services/docker.ts";

const SLOT = "sidecar";
const PIN_NAME = `${IMAGE_PIN_PREFIX}${SLOT}`;
const SIDECAR_IMAGE = "ghcr.io/appstrate/appstrate-sidecar:1.0.0";
const NEXT_SIDECAR_IMAGE = "ghcr.io/appstrate/appstrate-sidecar:1.1.0";

interface StubContainer {
  Id: string;
  Labels: Record<string, string>;
  Running: boolean;
}

interface EngineCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let calls: EngineCall[];
/** Container name -> container: the daemon's state, mutated by the calls. */
let containers: Map<string, StubContainer>;
let nextId: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function byId(id: string): [string, StubContainer] | undefined {
  return [...containers.entries()].find(([, c]) => c.Id === id);
}

/**
 * Stand up a stateful fake Engine: create/start/remove mutate `containers`,
 * so a later inspect sees what an earlier pass left behind. Creating over an
 * existing name answers 409 as the daemon does, so a replace that forgot to
 * remove first fails here too. Only the endpoints the pin touches are
 * implemented; anything else fails loudly rather than silently returning a
 * shape the code under test would misread.
 */
function stubEngine(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, path: url.pathname + url.search, body });

    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      if (containers.has(name)) return new Response("Conflict: name in use", { status: 409 });
      const Id = `pin-${nextId++}`;
      containers.set(name, {
        Id,
        Labels: (body?.Labels as Record<string, string>) ?? {},
        Running: false,
      });
      return json({ Id, Warnings: [] }, 201);
    }
    const start = url.pathname.match(/^\/containers\/([^/]+)\/start$/);
    if (method === "POST" && start) {
      const found = byId(start[1]!);
      if (!found) return new Response("no such container", { status: 404 });
      found[1].Running = true;
      return new Response(null, { status: 204 });
    }
    const inspect = url.pathname.match(/^\/containers\/([^/]+)\/json$/);
    if (method === "GET" && inspect) {
      const container = containers.get(decodeURIComponent(inspect[1]!));
      if (!container) return new Response("no such container", { status: 404 });
      return json({
        Id: container.Id,
        State: { Running: container.Running },
        Config: { Labels: container.Labels },
      });
    }
    const remove = url.pathname.match(/^\/containers\/([^/]+)$/);
    if (method === "DELETE" && remove) {
      const found = byId(remove[1]!);
      if (!found) return new Response("no such container", { status: 404 });
      containers.delete(found[0]);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unstubbed Docker call: ${method} ${url.pathname}`);
  }) as typeof fetch;
}

function creates(): EngineCall[] {
  return calls.filter((c) => c.method === "POST" && c.path.startsWith("/containers/create"));
}

function removedIds(): string[] {
  return calls
    .filter((c) => c.method === "DELETE")
    .map((c) => c.path.replace("/containers/", "").replace(/\?.*$/, ""));
}

function pinSpec(): string | undefined {
  return containers.get(PIN_NAME)?.Labels["appstrate.pin.spec"];
}

beforeEach(() => {
  calls = [];
  containers = new Map();
  nextId = 1;
  stubEngine();
});

afterEach(() => {
  // Restore before the next file runs: bun executes every suite in one
  // process, so a leaked global fetch would break unrelated tests.
  globalThis.fetch = realFetch;
});

describe("ensureImagePin", () => {
  it("creates a pin that never inherits the image healthcheck (#1521)", async () => {
    expect(await ensureImagePin(SIDECAR_IMAGE, SLOT)).toBe("created");

    expect(creates()).toHaveLength(1);
    const [create] = creates();
    expect(create!.path).toBe(`/containers/create?name=${PIN_NAME}`);
    const body = create!.body as {
      Image: string;
      Entrypoint: string[];
      Cmd: string[];
      Healthcheck: { Test: string[] };
      HostConfig: { NetworkMode: string };
      Labels: Record<string, string>;
    };
    expect(body.Image).toBe(SIDECAR_IMAGE);
    // The image's own HEALTHCHECK probes a process a pin never runs, so an
    // inherited one marks every pin permanently unhealthy.
    expect(body.Healthcheck.Test).toEqual(["NONE"]);
    expect([...body.Entrypoint, ...body.Cmd]).toEqual(["sleep", "infinity"]);
    expect(body.HostConfig.NetworkMode).toBe("none");
    expect(body.Labels["appstrate.pin.spec"]).toMatch(/^[0-9a-f]{64}$/);
    expect(containers.get(PIN_NAME)?.Running).toBe(true);
  });

  it("leaves a converged pin alone — same spec and running is a no-op", async () => {
    await ensureImagePin(SIDECAR_IMAGE, SLOT);
    calls = [];

    expect(await ensureImagePin(SIDECAR_IMAGE, SLOT)).toBe("unchanged");

    expect(creates()).toHaveLength(0);
    expect(removedIds()).toEqual([]);
  });

  it("replaces a pin from an older release that carries no spec label", async () => {
    // The upgrade path that repairs existing hosts: pins created before the
    // spec label existed still inherit the image healthcheck.
    containers.set(PIN_NAME, {
      Id: "legacy-pin",
      Labels: {
        "appstrate.role": "image-pin",
        "appstrate.pin.slot": SLOT,
        "appstrate.pin.image": SIDECAR_IMAGE,
      },
      Running: true,
    });

    expect(await ensureImagePin(SIDECAR_IMAGE, SLOT)).toBe("replaced");

    expect(removedIds()).toEqual(["legacy-pin"]);
    expect(pinSpec()).toMatch(/^[0-9a-f]{64}$/);
    expect(containers.get(PIN_NAME)?.Running).toBe(true);
  });

  it("replaces a pin whose image drifted, and the spec follows the image", async () => {
    await ensureImagePin(SIDECAR_IMAGE, SLOT);
    const previousId = containers.get(PIN_NAME)!.Id;
    const previousSpec = pinSpec();

    expect(await ensureImagePin(NEXT_SIDECAR_IMAGE, SLOT)).toBe("replaced");

    expect(removedIds()).toEqual([previousId]);
    expect(containers.get(PIN_NAME)?.Labels["appstrate.pin.image"]).toBe(NEXT_SIDECAR_IMAGE);
    expect(pinSpec()).not.toBe(previousSpec);
  });

  it("replaces a pin with the current spec that is no longer running", async () => {
    await ensureImagePin(SIDECAR_IMAGE, SLOT);
    const stopped = containers.get(PIN_NAME)!;
    const spec = pinSpec();
    stopped.Running = false;

    expect(await ensureImagePin(SIDECAR_IMAGE, SLOT)).toBe("replaced");

    expect(removedIds()).toEqual([stopped.Id]);
    // Deterministic fingerprint: the same image yields the same spec.
    expect(pinSpec()).toBe(spec);
    expect(containers.get(PIN_NAME)?.Running).toBe(true);
  });
});
