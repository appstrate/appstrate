// SPDX-License-Identifier: Apache-2.0

/**
 * The three writes that start runs — a launch, a schedule create, a schedule
 * update — each toast the `warnings` of their success body once (an update only
 * when it can change what the fires bind), naming each integration by the
 * display name the integration list holds: the cached list, else the list
 * fetched once through the same query — the id when it cannot be read.
 *
 * No DOM: a probe captures each hook's mutation during a static render, the
 * typed client's verb is stubbed, and the mutation is driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { $api, client } = await import("../../api/client.ts");
const { loadIntegrationNames } = await import("../use-integrations.ts");
const { render } = await import("../../test/render.tsx");
const { useRunLauncher } = await import("../use-mutations.ts");
const { useCreateSchedule, useUpdateSchedule } = await import("../use-schedules.ts");
const { scheduleKeys } = await import("../../lib/query-keys.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const i18nModule = await import("../../i18n.ts");

await i18nModule.i18nReady;
await i18nModule.default.changeLanguage("fr");

const AGENT = "@acme/mailer";
const WARNINGS = [
  { field: "integrations.@acme/gmail", code: "integration_unbound", message: "x", auth_key: "o" },
];
const EXPECTED = "Ce run s'exécute sans l'intégration Gmail";
const EXPECTED_SCHEDULE = "Les déclenchements s'exécuteront sans l'intégration Gmail";

const header = { "X-Org-Id": undefined, "X-Space-Id": undefined };
const LIST = {
  object: "list",
  data: [{ id: "@acme/gmail", manifest: { display_name: "Gmail" } }],
  hasMore: false,
};

/** The integration list as the SPA caches it — the toast reads names from here. */
function cachedClient(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(
    $api.queryOptions("get", "/api/integrations", { params: { header } }).queryKey,
    LIST,
  );
  return qc;
}

function capture<T>(useHook: () => T, qc: QueryClient): T {
  const captured: T[] = [];
  function Probe() {
    captured.push(useHook());
    return null;
  }
  render(<Probe />, { queryClient: qc });
  return captured[0]!;
}

const SCHEDULE = { id: "sch_1", packageId: AGENT, userId: "usr_bob", endUserId: null };

let warned: ReturnType<typeof spyOn>;
let stubs: { mockRestore: () => void }[];
beforeEach(() => {
  warned = spyOn(toast, "warning").mockImplementation(() => 0);
  // A launch leaves for the run page; outside an effect the router only warns about it.
  stubs = [spyOn(console, "warn").mockImplementation(() => {})];
});
afterEach(() => {
  warned.mockRestore();
  for (const s of stubs) s.mockRestore();
});

describe("launch warnings, wired", () => {
  it("a run launch toasts its warnings", async () => {
    stubs.push(
      spyOn(client, "POST").mockResolvedValue({
        data: { id: "run_1", warnings: WARNINGS },
      }),
    );
    const launcher = capture(() => useRunLauncher(AGENT), cachedClient());
    launcher.launch({});
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]![0]).toBe(EXPECTED);
  });

  it("names the integration by its id when the list is neither cached nor readable", async () => {
    stubs.push(
      spyOn(client, "POST").mockResolvedValue({
        data: { id: "run_1", warnings: WARNINGS },
      }),
    );
    const launcher = capture(() => useRunLauncher(AGENT), new QueryClient());
    launcher.launch({});
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(warned.mock.calls[0]![0]).toBe("Ce run s'exécute sans l'intégration @acme/gmail");
  });

  it("a launch with nothing missing toasts nothing", async () => {
    stubs.push(spyOn(client, "POST").mockResolvedValue({ data: { id: "run_1", warnings: [] } }));
    const launcher = capture(() => useRunLauncher(AGENT), cachedClient());
    launcher.launch({});
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(warned).not.toHaveBeenCalled();
  });

  it("a schedule create toasts its warnings", async () => {
    stubs.push(
      spyOn(client, "POST").mockResolvedValue({
        data: { ...SCHEDULE, warnings: WARNINGS },
      }),
    );
    const create = capture(() => useCreateSchedule(AGENT), cachedClient());
    await create.mutateAsync({ cron_expression: "0 9 * * *" });
    await Bun.sleep(0);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]![0]).toBe(EXPECTED_SCHEDULE);
  });

  it("a schedule update toasts its warnings", async () => {
    stubs.push(
      spyOn(client, "PATCH").mockResolvedValue({
        data: { ...SCHEDULE, warnings: WARNINGS },
      }),
    );
    const update = capture(() => useUpdateSchedule(), cachedClient());
    await update.mutateAsync({ id: "sch_1", enabled: true });
    await Bun.sleep(0);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]![0]).toBe(EXPECTED_SCHEDULE);
  });
});

describe("schedule update warnings — only when the write can change the fires", () => {
  const STORED = {
    ...SCHEDULE,
    enabled: true,
    version_override: null,
    connection_overrides: { "@acme/gmail": ["conn_1"] },
  };

  beforeEach(() => {
    stubs.push(
      spyOn(client, "PATCH").mockResolvedValue({ data: { ...SCHEDULE, warnings: WARNINGS } }),
    );
  });

  async function update(body: Record<string, unknown>, stored: object | null = STORED) {
    const qc = cachedClient();
    if (stored) {
      const key = scheduleKeys.detail(orgStore.getState().id, spaceStore.getState().id, "sch_1");
      qc.setQueryData(key, stored);
    }
    const mutation = capture(() => useUpdateSchedule(), qc);
    await mutation.mutateAsync({ id: "sch_1", ...body });
    await Bun.sleep(0);
    return warned.mock.calls.length;
  }

  it("a rename, a pause, or a save echoing the stored picks says nothing again", async () => {
    expect(await update({ name: "Renamed" })).toBe(0);
    expect(await update({ enabled: false })).toBe(0);
    expect(
      await update({
        name: "Renamed",
        enabled: true,
        connection_overrides: { "@acme/gmail": ["conn_1"] },
      }),
    ).toBe(0);
  });

  it("changed picks, a switch-on, an actor or a version change toast", async () => {
    expect(await update({ connection_overrides: { "@acme/gmail": [] } })).toBe(1);
    expect(await update({ enabled: true }, { ...STORED, enabled: false })).toBe(2);
    expect(await update({ actor: { userId: "usr_alice" } })).toBe(3);
    expect(await update({ version_override: "1.2.0" })).toBe(4);
  });

  it("toasts when the schedule as it stood is not cached", async () => {
    expect(await update({ name: "Renamed" }, null)).toBe(1);
  });
});

describe("loadIntegrationNames", () => {
  const readable = { header, enabled: true };
  const listResponse = () => ({ data: LIST, error: undefined, response: new Response(null) });

  it("reads a cached list without a request", async () => {
    const get = spyOn(client, "GET");
    stubs.push(get);
    const nameOf = await loadIntegrationNames(cachedClient(), readable);
    expect(nameOf("@acme/gmail")).toBe("Gmail");
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches an uncached list once, through the query the list hook caches", async () => {
    const get = spyOn(client, "GET").mockResolvedValue(listResponse());
    stubs.push(get);
    const qc = new QueryClient();
    expect((await loadIntegrationNames(qc, readable))("@acme/gmail")).toBe("Gmail");
    expect((await loadIntegrationNames(qc, readable))("@acme/slack")).toBe("@acme/slack");
    expect((get.mock.calls as unknown[][]).map(([path]) => path)).toEqual(["/api/integrations"]);
  });

  it("falls back to the id when the fetch fails", async () => {
    stubs.push(spyOn(client, "GET").mockRejectedValue(new Error("offline")));
    expect((await loadIntegrationNames(new QueryClient(), readable))("@acme/gmail")).toBe(
      "@acme/gmail",
    );
  });

  it("never requests a list the caller may not read", async () => {
    const get = spyOn(client, "GET");
    stubs.push(get);
    const unreadable = { header, enabled: false };
    expect((await loadIntegrationNames(new QueryClient(), unreadable))("@acme/gmail")).toBe(
      "@acme/gmail",
    );
    // Control: a list already cached still names it.
    expect((await loadIntegrationNames(cachedClient(), unreadable))("@acme/gmail")).toBe("Gmail");
    expect(get).not.toHaveBeenCalled();
  });
});
