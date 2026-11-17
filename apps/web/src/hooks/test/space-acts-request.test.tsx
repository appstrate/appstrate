// SPDX-License-Identifier: Apache-2.0

/**
 * An act from « Tous les espaces » runs in the space it names. Entering a space reads the agent
 * FROM that space before the switch (its `X-Space-Id`), never from the hidden working one; the
 * deletions carry the chosen or the row's space; the spanning reads ask the organization's doors.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { render } = await import("../../test/render.tsx");
const { client } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");
const { useAgentSpaceAction } = await import("../use-agent-run-space.ts");
const { packageDetailQueryOptions } = await import("../use-packages.ts");
const { useDeleteAgentRuns } = await import("../use-mutations.ts");
const { useDeleteAgentMemories, useDeletePersistenceRow, fetchAgentPersistence } =
  await import("../use-persistence.ts");
const { fetchAgentSchedules } = await import("../use-schedules.ts");
const { useRowSpaceGrants } = await import("../use-space-action.tsx");

const PACKAGE_ID = "@acme/reporter";

const space = (id: string, permissions: string[]) => ({
  id,
  object: "space",
  orgId: "org_1",
  access: "member",
  permissions,
  personal: false,
  isDefault: id === "spc_a",
  name: id,
  icon: null,
  color: null,
  role: null,
});

/** Atelier is the working space, hidden in the mode; Studio and Coffre run the agent. */
const SPACES = [
  space("spc_a", ["agents:read"]),
  space("spc_b", ["agents:read", "agents:run", "persistence:delete"]),
  space("spc_c", ["agents:read", "agents:run"]),
];

const WIRE_DETAIL = {
  id: PACKAGE_ID,
  source: "local",
  display_name: "Rapporteur",
  dependencies: { skills: [], integrations: [] },
  input: { schema: { type: "object", properties: {} }, values: {}, locked_fields: [] },
  running_runs: 0,
  manifest: { name: PACKAGE_ID },
  definition: "published",
  home_space_id: "spc_b",
  home_writable: false,
  home_deletable: false,
  home_shareable: false,
  effective_timeout_seconds: 300,
  active: true,
  space_ids: ["spc_b", "spc_c"],
};

let stubs: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const stub of stubs) stub.mockRestore();
  stubs = [];
  spaceStore.getState().setId("spc_a");
});

/** Renders `node` in Atelier, « Tous les espaces » on, with the space listing seeded. */
function renderInMode(node: React.ReactElement): QueryClient {
  stubs.push(
    spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    }),
    spyOn(spaceStore, "getInitialState").mockReturnValue({
      ...spaceStore.getInitialState(),
      id: "spc_a",
    }),
    spyOn(authStore, "getInitialState").mockReturnValue({
      ...authStore.getInitialState(),
      user: { id: "u_1", email: "u@example.test", emailVerified: true },
    }),
    spyOn(overviewStore, "getInitialState").mockReturnValue({
      ...overviewStore.getInitialState(),
      chosen: { "u_1:org_1": true },
    }),
  );
  spaceStore.getState().setId("spc_a");
  const qc = new QueryClient();
  qc.setQueryData(["orgs"], [{ id: "org_1", permissions: [] }]);
  qc.setQueryData(["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }], {
    object: "list",
    hasMore: false,
    data: SPACES,
  });
  render(node, { queryClient: qc });
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
