// SPDX-License-Identifier: Apache-2.0

/**
 * The three writes that start runs — a launch, a schedule create, a schedule
 * update — each toast the `warnings` of their success body once (`null`, a
 * schedule write that judged nothing, says nothing), naming each warned
 * integration by the display name its own detail holds: the cached detail, else
 * the detail fetched once through the same query — the id when it cannot be read.
 *
 * No DOM: a probe captures each hook's mutation during a static render, the
 * typed client's verb is stubbed, and the mutation is driven by hand.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ApiError } from "../../api/errors";
import { scheduleKeys } from "../../lib/query-keys";
import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { $api, client } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { loadIntegrationNames } = await import("../use-integrations.ts");
const { render } = await import("../../test/render.tsx");
const { useRunLauncher } = await import("../use-mutations.ts");
const { useCreateSchedule, useUpdateSchedule } = await import("../use-schedules.ts");
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
const GMAIL_DETAIL = { manifest: { display_name: "Gmail" }, auths: [] };
const detailKey = (packageId: string) =>
  $api.queryOptions("get", "/api/integrations/{packageId}", {
    params: { path: { packageId }, header },
  }).queryKey;

/** Gmail's detail as the SPA caches it — the toast reads its name from here. */
function cachedClient(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(detailKey("@acme/gmail"), GMAIL_DETAIL);
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

  it("names the integration by its id when its detail is neither cached nor readable", async () => {
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

  it("sends the displayed schedule revision, refreshes on conflict and retries only with the reviewed revision", async () => {
    const qc = cachedClient();
    const key = scheduleKeys.detail("org", "space", "sch_1");
    qc.setQueryData(key, SCHEDULE);
    const patch = spyOn(client, "PATCH")
      .mockRejectedValueOnce(new ApiError("precondition_failed", "Changed", 412))
      .mockResolvedValueOnce({ data: { ...SCHEDULE, warnings: null } });
    stubs.push(patch);
    const update = capture(() => useUpdateSchedule(), qc);
    const first = { id: "sch_1", etag: '"1"', enabled: false };
    await expect(update.mutateAsync(first)).rejects.toMatchObject({ status: 412 });
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    await update.mutateAsync({ ...first, etag: '"2"' });
    for (const [index, etag] of ['"1"', '"2"'].entries()) {
      expect(patch).toHaveBeenNthCalledWith(index + 1, "/api/schedules/{id}", {
        params: { path: { id: "sch_1" }, header: { "If-Match": etag } },
        body: { enabled: false },
      });
    }
  });

  it("a schedule update toasts its warnings", async () => {
    stubs.push(
      spyOn(client, "PATCH").mockResolvedValue({
        data: { ...SCHEDULE, warnings: WARNINGS },
      }),
    );
    const update = capture(() => useUpdateSchedule(), cachedClient());
    await update.mutateAsync({ id: "sch_1", etag: '"v1"', enabled: true });
    await Bun.sleep(0);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]![0]).toBe(EXPECTED_SCHEDULE);
  });
});

describe("the Connecter action", () => {
  const ORG_ID = "org_1";
  const CONNECTABLE = [{ field: "integrations.@acme/gmail", code: "not_connected", message: "x" }];

  /** The action a launch's toast carries for a viewer holding `permissions` in the org. */
  async function actionFor(permissions: string[]): Promise<unknown> {
    const qc = cachedClient();
    qc.setQueryData(
      ["orgs"],
      [{ id: ORG_ID, name: "Acme", slug: "acme", role: "member", permissions }],
    );
    stubs.push(
      spyOn(orgStore, "getInitialState").mockReturnValue({
        ...orgStore.getInitialState(),
        id: ORG_ID,
      }),
      spyOn(client, "POST").mockResolvedValue({ data: { id: "run_1", warnings: CONNECTABLE } }),
    );
    const launcher = capture(() => useRunLauncher(AGENT), qc);
    launcher.launch({});
    await Bun.sleep(0);
    await Bun.sleep(0);
    return (warned.mock.calls[0]![1] as { action?: unknown }).action;
  }

  it("is offered when the viewer reaches the agent's page and sees its Connexions tab", async () => {
    expect(await actionFor(["studio:read", "agents:read", "integrations:read"])).toBeDefined();
  });

  it("is withheld from a role without the Studio, where the agent's page is", async () => {
    expect(await actionFor(["agents:read", "integrations:read"])).toBeUndefined();
  });

  it("is withheld when the page shows the viewer no Connexions tab", async () => {
    expect(await actionFor(["agents:read"])).toBeUndefined();
  });

  it("is withheld from a viewer the agent's page is closed to", async () => {
    expect(await actionFor(["integrations:read"])).toBeUndefined();
  });
});

describe("schedule writes — the toast follows the server's verdict", () => {
  async function write(verb: "POST" | "PATCH", warnings: unknown[] | null): Promise<number> {
    stubs.push(spyOn(client, verb).mockResolvedValue({ data: { ...SCHEDULE, warnings } }));
    if (verb === "POST") {
      const create = capture(() => useCreateSchedule(AGENT), cachedClient());
      await create.mutateAsync({ cron_expression: "0 9 * * *" });
    } else {
      const update = capture(() => useUpdateSchedule(), cachedClient());
      await update.mutateAsync({ id: "sch_1", etag: '"v1"', name: "Renamed" });
    }
    await Bun.sleep(0);
    return warned.mock.calls.length;
  }

  it("says nothing on `null` (nothing judged, or withheld) nor on `[]`", async () => {
    expect(await write("PATCH", null)).toBe(0);
    expect(await write("PATCH", [])).toBe(0);
    expect(await write("POST", null)).toBe(0);
    expect(await write("POST", [])).toBe(0);
  });

  it("toasts the items of any write the server judged, whatever its body", async () => {
    expect(await write("PATCH", WARNINGS)).toBe(1);
  });
});

describe("loadIntegrationNames", () => {
  const readable = { header, enabled: true };
  const GMAIL = ["@acme/gmail"];
  const detailResponse = () => ({
    data: { data: [{ id: "@acme/gmail", ...GMAIL_DETAIL }] },
    error: undefined,
    response: new Response(null),
  });

  it("reads a cached detail without a request", async () => {
    const get = spyOn(client, "GET");
    stubs.push(get);
    const nameOf = await loadIntegrationNames(cachedClient(), readable, GMAIL);
    expect(nameOf("@acme/gmail")).toBe("Gmail");
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches only the warned integrations, once, through the scoped catalogue", async () => {
    const get = spyOn(client, "GET").mockResolvedValue(detailResponse());
    stubs.push(get);
    const qc = new QueryClient();
    expect((await loadIntegrationNames(qc, readable, GMAIL))("@acme/gmail")).toBe("Gmail");
    expect((await loadIntegrationNames(qc, readable, GMAIL))("@acme/gmail")).toBe("Gmail");
    // An id it was not asked for is not looked up.
    expect((await loadIntegrationNames(qc, readable, GMAIL))("@acme/slack")).toBe("@acme/slack");
    expect(get.mock.calls as unknown[][]).toHaveLength(1);
    const [path, init] = get.mock.calls[0] as unknown as [string, { params: { query: unknown } }];
    expect(path).toBe("/api/integrations");
    expect(init.params.query).toEqual({ id: GMAIL, limit: 100 });
  });

  it("resolves 101 missing names in two reads and preserves the successful batch", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `@acme/item-${String(i).padStart(3, "0")}`);
    const get = spyOn(client, "GET")
      .mockResolvedValueOnce({
        data: {
          data: ids.slice(0, 100).map((id) => ({ id, manifest: { display_name: "Known" } })),
        },
      })
      .mockRejectedValueOnce(new Error("offline"));
    stubs.push(get);
    const nameOf = await loadIntegrationNames(new QueryClient(), readable, [...ids, ids[0]!]);
    expect(nameOf(ids[0]!)).toBe("Known");
    expect(nameOf(ids[100]!)).toBe(ids[100]!);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("falls back to the id when the fetch fails", async () => {
    stubs.push(spyOn(client, "GET").mockRejectedValue(new Error("offline")));
    expect((await loadIntegrationNames(new QueryClient(), readable, GMAIL))("@acme/gmail")).toBe(
      "@acme/gmail",
    );
  });

  it("never requests a detail the caller may not read", async () => {
    const get = spyOn(client, "GET");
    stubs.push(get);
    const unreadable = { header, enabled: false };
    expect((await loadIntegrationNames(new QueryClient(), unreadable, GMAIL))("@acme/gmail")).toBe(
      "@acme/gmail",
    );
    // Control: a detail already cached still names it.
    expect((await loadIntegrationNames(cachedClient(), unreadable, GMAIL))("@acme/gmail")).toBe(
      "Gmail",
    );
    expect(get).not.toHaveBeenCalled();
  });
});
