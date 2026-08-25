// SPDX-License-Identifier: Apache-2.0

/**
 * The daemon-wide orphan sweep, driven against a stubbed Docker Engine (#1130).
 *
 * The behaviour that matters here — which containers a boot sweep is allowed
 * to remove — is decided from a listing payload and from the label filter that
 * listing was requested with, not from anything a real daemon does.
 * `apps/api/test/integration/services/docker-api.test.ts` covers the same
 * ground against a live daemon, but those cases are gated behind
 * `TEST_DOCKER=1` and no workflow sets it, so CI would otherwise verify none
 * of this. Stubbing `fetch` keeps the decision under test at tier 0.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getEnv } from "@appstrate/env";
import {
  cleanupOrphanedContainers,
  removeContainersByRun,
  stopContainersByRun,
  waitForExit,
} from "../../../src/services/docker.ts";
import { DockerContainerDisappearedError } from "../../../src/services/docker-errors.ts";

interface StubContainer {
  Id: string;
  State: string;
  /** Seconds of age at the moment of the sweep. */
  ageSeconds?: number;
  Labels?: Record<string, string>;
}

interface EngineCall {
  method: string;
  path: string;
}

const realFetch = globalThis.fetch;
let calls: EngineCall[];

/** Container id -> HTTP status the stubbed daemon answers its DELETE with. */
let removalStatus: Map<string, number>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The daemon's own label-filter semantics, as `MatchKVList` implements them:
 * every entry of `{"label":[…]}` must match (AND, not OR), `k=v` demands that
 * exact value, a bare `k` demands only that the label be present, and an EMPTY
 * list constrains nothing — it lists the whole host.
 *
 * Modelled instead of ignored because that argument is the ONLY thing keeping
 * the sweep off containers Appstrate did not create. A stub answering every
 * listing with its whole fixture set cannot tell a correctly scoped call from
 * `listContainers([])`, which is exactly the mistake that would matter.
 */
function matchesLabelFilter(container: StubContainer, filters: string | null): boolean {
  if (filters === null) return true;
  const wanted = (JSON.parse(filters) as { label?: string[] }).label ?? [];
  const labels = container.Labels ?? {};
  return wanted.every((entry) => {
    const separator = entry.indexOf("=");
    if (separator === -1) return entry in labels;
    return labels[entry.slice(0, separator)] === entry.slice(separator + 1);
  });
}

/**
 * A container this instance created — carrying the marker the daemon-wide
 * sweep filters on. Every fixture the sweep is *supposed* to see goes through
 * here; a bare literal is a decoy the daemon would never hand back, and the
 * decoys are the point of these cases.
 */
function managed(container: StubContainer): StubContainer {
  return { ...container, Labels: { ...container.Labels, "appstrate.managed": "true" } };
}

/** A managed container owned by one run — the scope `runLabels` builds. */
function ofRun(runId: string, container: StubContainer): StubContainer {
  return managed({ ...container, Labels: { ...container.Labels, "appstrate.run": runId } });
}

/**
 * Stand up a fake Engine holding `containers`. Only the endpoints the sweep
 * touches are implemented; anything else fails loudly rather than silently
 * returning a shape the code under test would misread.
 */
function stubEngine(containers: StubContainer[], options: { inspect404?: boolean } = {}): void {
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search });

    if (url.pathname === "/containers/json") {
      return json(
        containers
          .filter((c) => matchesLabelFilter(c, url.searchParams.get("filters")))
          .map((c) => ({
            Id: c.Id,
            State: c.State,
            Created: now - (c.ageSeconds ?? 0),
            Labels: c.Labels ?? {},
          })),
      );
    }
    if (url.pathname === "/networks") return json([]);
    if (url.pathname === "/volumes") return json({ Volumes: [] });
    if (url.pathname.endsWith("/json")) {
      // Container inspect — used by waitForExit.
      if (options.inspect404) return new Response("no such container", { status: 404 });
      return json({ State: { Status: "exited", ExitCode: 0 } });
    }
    if (method === "DELETE") {
      const id = url.pathname.replace("/containers/", "").replace(/\?.*$/, "");
      const status = removalStatus.get(id) ?? 204;
      return new Response(status === 204 ? null : `daemon said ${status}`, { status });
    }
    if (method === "POST") return new Response(null, { status: 204 });
    throw new Error(`unstubbed Docker call: ${method} ${url.pathname}`);
  }) as typeof fetch;
}

/** Ids the caller asked the daemon to stop, in call order. */
function stoppedIds(): string[] {
  return calls
    .filter((c) => c.method === "POST" && c.path.includes("/stop"))
    .map((c) => c.path.replace("/containers/", "").replace(/\/stop.*$/, ""));
}

/** Ids the sweep asked the daemon to remove, in call order. */
function removedIds(): string[] {
  return calls
    .filter((c) => c.method === "DELETE")
    .map((c) => c.path.replace("/containers/", "").replace(/\?.*$/, ""));
}

beforeEach(() => {
  calls = [];
  removalStatus = new Map();
});

afterEach(() => {
  // Restore before the next file runs: bun executes every suite in one
  // process, so a leaked global fetch would break unrelated tests.
  globalThis.fetch = realFetch;
});

describe("cleanupOrphanedContainers", () => {
  it("removes only what is provably finished, and never a live sibling's workload", async () => {
    stubEngine([
      managed({ Id: "exited-1", State: "exited" }),
      managed({ Id: "dead-1", State: "dead" }),
      managed({ Id: "running-1", State: "running" }),
      managed({ Id: "paused-1", State: "paused" }),
      managed({ Id: "restarting-1", State: "restarting" }),
      managed({ Id: "removing-1", State: "removing" }),
      managed({ Id: "future-state-1", State: "some-state-a-newer-engine-invented" }),
      managed({ Id: "provisioning-1", State: "created", ageSeconds: 2 }),
      managed({ Id: "abandoned-1", State: "created", ageSeconds: 86_400 }),
      // Not ours. Both would satisfy `isReclaimableContainer` on state alone,
      // so the label filter is the only thing between them and a force-remove:
      // a developer's stopped database, and another tool's abandoned builder.
      { Id: "someones-postgres", State: "exited" },
      {
        Id: "someones-build-container",
        State: "created",
        ageSeconds: 86_400,
        Labels: { "com.docker.compose.project": "not-appstrate" },
      },
    ]);

    const report = await cleanupOrphanedContainers();

    expect(removedIds().sort()).toEqual(["abandoned-1", "dead-1", "exited-1"]);
    expect(report.containers).toBe(3);
  });

  it("puts the created cutoff exactly at the run boot deadline", async () => {
    // Not a round number picked for the test: past this point the platform's
    // own liveness contract says no run may still be provisioning.
    const deadline = getEnv().RUN_BOOT_DEADLINE_SECONDS;
    stubEngine([
      managed({ Id: "just-inside", State: "created", ageSeconds: deadline - 5 }),
      managed({ Id: "just-outside", State: "created", ageSeconds: deadline + 5 }),
    ]);

    await cleanupOrphanedContainers();

    expect(removedIds()).toEqual(["just-outside"]);
  });

  it("lists with all=true — the default listing hides every non-running row", async () => {
    stubEngine([managed({ Id: "exited-1", State: "exited" })]);

    await cleanupOrphanedContainers();

    const listing = calls.find((c) => c.path.startsWith("/containers/json"));
    expect(listing?.path).toContain("all=true");
  });

  it("counts removals that succeeded, not containers that were listed", async () => {
    // Reporting the listing length claimed success even when every removal
    // failed, so a boot that reclaimed nothing logged a healthy cleanup.
    stubEngine([
      managed({ Id: "exited-1", State: "exited" }),
      managed({ Id: "exited-2", State: "exited" }),
      managed({ Id: "exited-3", State: "exited" }),
    ]);
    removalStatus = new Map([
      ["exited-2", 500],
      ["exited-3", 500],
    ]);

    const report = await cleanupOrphanedContainers();

    expect(removedIds().length).toBe(3);
    expect(report.containers).toBe(1);
  });

  it("treats an already-gone container as reclaimed — the postcondition is 'gone'", async () => {
    stubEngine([managed({ Id: "exited-1", State: "exited" })]);
    removalStatus = new Map([["exited-1", 404]]);

    const report = await cleanupOrphanedContainers();

    expect(report.containers).toBe(1);
  });

  it("reports zero when the daemon holds nothing managed", async () => {
    // A daemon that is not empty, just empty OF OURS — the distinction the
    // filter draws, and the one a sweep that reaps by state alone erases.
    stubEngine([
      { Id: "someones-postgres", State: "exited" },
      { Id: "someones-dead-build", State: "dead" },
    ]);

    const report = await cleanupOrphanedContainers();

    expect(report).toEqual({ containers: 0, networks: 0, volumes: 0 });
    expect(removedIds()).toEqual([]);
  });
});

describe("per-run reaping (ownership proven by the caller's database)", () => {
  it("removeContainersByRun removes regardless of state, unlike the sweep", async () => {
    // The runId came from our own DB, which IS the ownership proof the
    // daemon-wide sweep lacks — so a running container is fair game here.
    stubEngine([
      ofRun("run-1", { Id: "agent", State: "running" }),
      ofRun("run-1", { Id: "sidecar", State: "created", ageSeconds: 1 }),
      // A sibling run's live workload and a container that is not Appstrate's
      // at all. `runLabels` is the whole of what spares them: this call
      // force-removes everything the listing hands back, whatever its state.
      ofRun("run-2", { Id: "other-run-agent", State: "running" }),
      { Id: "someones-postgres", State: "running" },
    ]);

    const removed = await removeContainersByRun("run-1");

    expect(removed).toBe(2);
    expect(removedIds().sort()).toEqual(["agent", "sidecar"]);
    expect(calls[0]?.path).toContain("all=true");
  });

  it("stopContainersByRun reports not_found when the run owns nothing", async () => {
    // Again a populated daemon: "not_found" must mean "nothing labelled for
    // run-1", not "nothing running anywhere".
    stubEngine([
      ofRun("run-2", { Id: "other-run-agent", State: "running" }),
      { Id: "someones-postgres", State: "running" },
    ]);

    expect(await stopContainersByRun("run-1")).toBe("not_found");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("stopContainersByRun stops what the run owns, and nothing else", async () => {
    stubEngine([
      ofRun("run-1", { Id: "agent", State: "running" }),
      { Id: "someones-postgres", State: "running" },
    ]);

    expect(await stopContainersByRun("run-1")).toBe("stopped");
    expect(stoppedIds()).toEqual(["agent"]);
  });
});

describe("waitForExit", () => {
  it("rejects when the container disappears mid-poll instead of reporting SIGKILL", async () => {
    // 137 asserted an OOM kill that never happened. A container can vanish
    // from a host prune, a daemon restart, or another instance's boot sweep.
    stubEngine([], { inspect404: true });

    await expect(waitForExit("vanished-container-id")).rejects.toThrow(
      DockerContainerDisappearedError,
    );
  });

  it("names the container it lost, so the failure is diagnosable", async () => {
    stubEngine([], { inspect404: true });

    await expect(waitForExit("abcdef0123456789")).rejects.toThrow(/abcdef012345/);
  });
});
