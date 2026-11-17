// SPDX-License-Identifier: Apache-2.0

/**
 * An act from « Tous les espaces » runs in the space it names. Entering a space reads the agent
 * FROM that space before the switch (its `X-Space-Id`), never from the hidden working one; the
 * deletions carry the chosen or the row's space; the spanning reads ask the organization's doors.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { reporter } from "../../test/agent-detail.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { client } = await import("../../api/client.ts");
const { renderInSpace, testSpace } = await import("../../test/space-context.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { useAgentSpaceAction } = await import("../use-agent-run-space.ts");
const { packageDetailQueryOptions } = await import("../use-packages.ts");
const { useDeleteAgentRuns } = await import("../use-mutations.ts");
const { useDeleteAgentMemories, useDeletePersistenceRow, fetchAgentPersistence } =
  await import("../use-persistence.ts");
const { useCanReachInSpace } = await import("../use-can-reach.ts");
const { usePackageVersions } = await import("../use-packages.ts");
const { useIntegrationDetail } = await import("../use-integrations.ts");
const { useImportPackage, useImportFromGithub } = await import("../use-mutations.ts");
const { fetchAgentSchedules } = await import("../use-schedules.ts");
const { useRowSpaceGrants } = await import("../use-permissions.ts");

const PACKAGE_ID = "@acme/reporter";

/** Atelier is the working space, hidden in the mode; Studio and Coffre run the agent. */
const SPACES = [
  testSpace("spc_a", ["agents:read"]),
  testSpace("spc_b", [
    "agents:read",
    "agents:run",
    "persistence:delete",
    "integrations:read",
    "runs:read",
  ]),
  testSpace("spc_c", ["agents:read", "agents:run"]),
];

const WIRE_DETAIL = reporter({ active: true });

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
  spaceStore.getState().setId("spc_a");
});

/** Renders `node` in Atelier, « Tous les espaces » on, with the space listing seeded. */
function renderInMode(node: React.ReactElement): QueryClient {
  spaceStore.getState().setId("spc_a");
  const qc = new QueryClient();
  qc.setQueryData(["orgs"], [{ id: "org_1", permissions: [] }]);
  qc.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }], {
    object: "list",
    hasMore: false,
    data: SPACES,
  });
  renderInSpace(node, { overview: true, queryClient: qc });
  return qc;
}

/** Captures what a hook returns on render, to act on it afterwards. */
function capture<T>(useHook: () => T): { current: T | undefined; Probe: () => null } {
  const box: { current: T | undefined; Probe: () => null } = {
    current: undefined,
    Probe: () => {
      box.current = useHook();
      return null;
    },
  };
  return box;
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await Bun.sleep(1);
};

describe("entering a space to act there", () => {
  let get: ReturnType<typeof spyOn>;
  beforeEach(() => {
    get = spyOn(client, "GET").mockResolvedValue({
      data: WIRE_DETAIL,
      response: new Response(null, { headers: { ETag: '"v1"' } }),
    });
  });
  afterEach(() => get.mockRestore());

  it("reads the agent from the CHOSEN space before entering it, and acts with that read", async () => {
    const action = capture(() =>
      useAgentSpaceAction(PACKAGE_ID, "agents:run", ["spc_b", "spc_c"], {
        preferWorkingSpace: false,
      }),
    );
    const qc = renderInMode(<action.Probe />);
    let entered: unknown = "not run";
    const menu = action.current!.choose("Lancer dans…", () => {
      entered = qc.getQueryData(
        packageDetailQueryOptions("agent", { orgId: "org_1", spaceId: "spc_c" }, PACKAGE_ID)
          .queryKey,
      );
    });
    expect(menu?.spaces.map((s) => s.id)).toEqual(["spc_b", "spc_c"]);

    menu!.onPick("spc_c");
    await until(() => entered !== "not run");

    expect(get.mock.calls).toHaveLength(1);
    const [path, init] = get.mock.calls[0] as [string, { headers?: Record<string, string> }];
    expect(path).toBe("/api/packages/agents/{scope}/{name}");
    expect(init.headers?.["X-Space-Id"]).toBe("spc_c");
    expect(spaceStore.getState().id).toBe("spc_c");
    expect((entered as { id?: string } | undefined)?.id).toBe(PACKAGE_ID);
  });

  it("does not enter a space whose read fails", async () => {
    get.mockRejectedValue(new Error("404"));
    const action = capture(() =>
      useAgentSpaceAction(PACKAGE_ID, "agents:run", ["spc_b", "spc_c"], {
        preferWorkingSpace: false,
      }),
    );
    renderInMode(<action.Probe />);
    let ran = false;
    action.current!.choose("Lancer dans…", () => (ran = true))!.onPick("spc_b");
    await Bun.sleep(5);
    expect(ran).toBe(false);
    expect(spaceStore.getState().id).toBe("spc_a");
  });

  it("offers nothing in the mode for an agent active in none of the reader's spaces", () => {
    const action = capture(() => useAgentSpaceAction(PACKAGE_ID, "agents:run", []));
    renderInMode(<action.Probe />);
    expect(action.current!.offered).toBe(false);
  });
});

describe("the deletions name their space", () => {
  let del: ReturnType<typeof spyOn>;
  beforeEach(() => {
    del = spyOn(client, "DELETE").mockResolvedValue({ data: { deleted_count: 0 } });
  });
  afterEach(() => del.mockRestore());

  const spaceOf = (call: unknown[]) => {
    const init = call[1] as {
      headers?: Record<string, string>;
      params?: { header?: Record<string, string> };
    };
    return init.headers?.["X-Space-Id"] ?? init.params?.header?.["X-Space-Id"];
  };

  it("« Supprimer les runs » in the chosen space", async () => {
    const hook = capture(() => useDeleteAgentRuns(PACKAGE_ID));
    renderInMode(<hook.Probe />);
    await hook.current!.mutateAsync("spc_c");
    expect(del.mock.calls[0]![0]).toBe("/api/agents/{scope}/{name}/runs");
    expect(spaceOf(del.mock.calls[0])).toBe("spc_c");
  });

  it("« Supprimer les mémoires » in the chosen space", async () => {
    const hook = capture(() => useDeleteAgentMemories(PACKAGE_ID));
    renderInMode(<hook.Probe />);
    await hook.current!.mutateAsync("spc_b");
    expect(del.mock.calls[0]![0]).toBe("/api/agents/{scope}/{name}/persistence");
    expect(spaceOf(del.mock.calls[0])).toBe("spc_b");
  });

  it("one memory row in its own space, of either kind", async () => {
    const hook = capture(() => useDeletePersistenceRow(PACKAGE_ID));
    renderInMode(<hook.Probe />);
    await hook.current!.mutateAsync({ kind: "pinned", id: 3, spaceId: "spc_b" });
    await hook.current!.mutateAsync({ kind: "archive", id: 4, spaceId: "spc_c" });
    expect((del.mock.calls as unknown[][]).map((call) => [call[0], spaceOf(call)])).toEqual([
      ["/api/agents/{scope}/{name}/persistence/pinned/{id}", "spc_b"],
      ["/api/agents/{scope}/{name}/persistence/memories/{id}", "spc_c"],
    ]);
  });
});

describe("a memory row's delete", () => {
  it("is offered where the row's own space grants it, not the hidden working space", () => {
    const grants = capture(() => useRowSpaceGrants());
    renderInMode(<grants.Probe />);
    expect(grants.current!("spc_b", "persistence:delete")).toBe(true);
    expect(grants.current!("spc_c", "persistence:delete")).toBe(false);
  });
});

describe("the spanning reads of an agent", () => {
  let get: ReturnType<typeof spyOn>;
  beforeEach(() => {
    get = spyOn(client, "GET").mockResolvedValue({ data: { object: "list", data: [] } });
  });
  afterEach(() => get.mockRestore());

  it("ask the organization's persistence door, naming no space", async () => {
    await fetchAgentPersistence(PACKAGE_ID, "org_1", { kind: "memory" });
    await fetchAgentPersistence(PACKAGE_ID, null, { kind: "pinned" });
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/agents/{scope}/{name}/persistence",
        {
          params: {
            path: { orgId: "org_1", scope: "@acme", name: "reporter" },
            query: { kind: "memory" },
          },
        },
      ],
      [
        "/api/agents/{scope}/{name}/persistence",
        { params: { path: { scope: "@acme", name: "reporter" }, query: { kind: "pinned" } } },
      ],
    ]);
  });

  it("ask the organization's schedules narrowed to the agent", async () => {
    await fetchAgentSchedules(PACKAGE_ID, "org_1");
    await fetchAgentSchedules(PACKAGE_ID, null);
    expect(get.mock.calls).toEqual([
      [
        "/api/orgs/{orgId}/schedules",
        { params: { path: { orgId: "org_1" }, query: { packageId: PACKAGE_ID } } },
      ],
      [
        "/api/agents/{scope}/{name}/schedules",
        { params: { path: { scope: "@acme", name: "reporter" } } },
      ],
    ]);
  });
});

describe("resources opened from a spanning list", () => {
  it("judges a notification's run link in its own space even when it is the hidden working space", () => {
    const link = capture(() => useCanReachInSpace());
    renderInMode(<link.Probe />);
    const target = "/agents/@acme/reporter/runs/run_1";
    expect(link.current!(target, "spc_a")).toBe(false);
    expect(link.current!(target, "spc_b")).toBe(true);
  });

  it("reads the dependency's tools and versions where it is listed, without switching the editor", () => {
    const probe = capture(() => ({
      tools: useIntegrationDetail(PACKAGE_ID, "spc_b"),
      versions: usePackageVersions("integration", PACKAGE_ID, "spc_b"),
    }));
    const qc = renderInMode(<probe.Probe />);
    for (const path of [
      "/api/integrations/{packageId}",
      "/api/packages/integrations/{scope}/{name}/versions",
    ]) {
      const query = qc.getQueryCache().find({ queryKey: ["get", path], exact: false });
      expect(query?.queryKey[2]).toMatchObject({ params: { header: { "X-Space-Id": "spc_b" } } });
      expect(query?.options).toMatchObject({ enabled: true });
    }
    expect(spaceStore.getState().id).toBe("spc_a");
  });

  it("imports archives and GitHub dependencies in the selected space while the editor stays put", async () => {
    const post = spyOn(client, "POST").mockResolvedValue({
      data: {
        packageId: PACKAGE_ID,
        root_package_id: PACKAGE_ID,
        type: "integration",
        version: "1.0.0",
      },
    });
    stubs.push(post);
    const imports = capture(() => ({ archive: useImportPackage(), github: useImportFromGithub() }));
    renderInMode(<imports.Probe />);
    for (const name of ["a.afps", "a.afps-bundle"]) {
      await imports.current!.archive.mutateAsync({
        file: new File(["example"], name),
        spaceId: "spc_b",
        type: "integration",
      });
    }
    await imports.current!.github.mutateAsync({
      url: "https://github.com/acme/a",
      type: "integration",
      spaceId: "spc_b",
    });
    const calls: readonly (readonly unknown[])[] = post.mock.calls;
    expect(calls.map(([path]) => path)).toEqual([
      "/api/packages/import",
      "/api/packages/import-bundle",
      "/api/packages/import-github",
    ]);
    for (const [, init] of calls) {
      expect(init).toMatchObject({ params: { header: { "X-Space-Id": "spc_b" } } });
    }
    expect(spaceStore.getState().id).toBe("spc_a");
  });
});
