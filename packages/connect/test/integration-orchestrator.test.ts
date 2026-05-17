// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the integration spawn orchestrator (proposal §5.4.2).
 */

import { describe, it, expect } from "bun:test";
import {
  SpawnFailureError,
  spawnIntegrations,
  type IntegrationOrchestratorEvent,
  type IntegrationSpawnRequest,
  type SignalDispatcher,
} from "../src/integration-orchestrator.ts";
import type { ChildExit, ChildHandle } from "../src/restart-supervisor.ts";

function makeChild() {
  let resolveExit!: (exit: ChildExit) => void;
  const exited = new Promise<ChildExit>((res) => {
    resolveExit = res;
  });
  let killed = false;
  const handle: ChildHandle = {
    exited,
    kill() {
      killed = true;
      // Test child responds to kill by exiting cleanly with SIGTERM.
      resolveExit({ kind: "signal", signal: "SIGTERM" });
    },
  };
  return {
    handle,
    crash: (code = 1) => resolveExit({ kind: "normal-exit", code }),
    sigterm: () => resolveExit({ kind: "signal", signal: "SIGTERM" }),
    get killed() {
      return killed;
    },
  };
}

describe("spawnIntegrations — parallel initialisation", () => {
  it("returns once every first spawn succeeds", async () => {
    const children = [makeChild(), makeChild()];
    const reqs: IntegrationSpawnRequest[] = [
      {
        integrationId: "i1",
        namespace: "gmail",
        spawn: async () => children[0]!.handle,
      },
      {
        integrationId: "i2",
        namespace: "linear",
        spawn: async () => children[1]!.handle,
      },
    ];

    const orch = await spawnIntegrations(reqs);
    expect(orch.running.length).toBe(2);
    expect(orch.running.every((r) => r.initialised)).toBe(true);
    expect(orch.get("i1")?.namespace).toBe("gmail");

    await orch.shutdown();
    expect(children.every((c) => c.killed)).toBe(true);
  });

  it("rejects on duplicate integrationId in the request set", async () => {
    const reqs: IntegrationSpawnRequest[] = [
      { integrationId: "x", namespace: "a", spawn: async () => makeChild().handle },
      { integrationId: "x", namespace: "b", spawn: async () => makeChild().handle },
    ];
    let caught: unknown;
    try {
      await spawnIntegrations(reqs);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/duplicate integrationId/);
  });
});

describe("spawnIntegrations — first-spawn failure", () => {
  it("rolls back successful integrations when one fails permanently", async () => {
    const goodChild = makeChild();
    const reqs: IntegrationSpawnRequest[] = [
      {
        integrationId: "ok",
        namespace: "ok",
        spawn: async () => goodChild.handle,
      },
      {
        integrationId: "bad",
        namespace: "bad",
        spawn: async () => {
          throw new Error("can't spawn");
        },
        supervisorOptions: {
          schedule: [1, 1],
          sleep: () => Promise.resolve(),
        },
      },
    ];

    let caught: unknown;
    try {
      await spawnIntegrations(reqs);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SpawnFailureError);
    expect((caught as SpawnFailureError).integrationId).toBe("bad");
    // The good one should have been torn down.
    expect(goodChild.killed).toBe(true);
  });
});

describe("spawnIntegrations — signalCredentialRefresh", () => {
  it("sends SIGHUP only to afpsAware integrations", async () => {
    const a = makeChild();
    const b = makeChild();
    const c = makeChild();
    const seen: Array<{ id: string; signal: string }> = [];

    const signaller: SignalDispatcher = {
      async signal(id, signal) {
        seen.push({ id, signal });
        return true;
      },
    };

    const reqs: IntegrationSpawnRequest[] = [
      {
        integrationId: "aware-1",
        namespace: "g",
        afpsAware: true,
        spawn: async () => a.handle,
      },
      {
        integrationId: "aware-2",
        namespace: "l",
        afpsAware: true,
        spawn: async () => b.handle,
      },
      {
        integrationId: "unaware",
        namespace: "s",
        afpsAware: false,
        spawn: async () => c.handle,
      },
    ];

    const orch = await spawnIntegrations(reqs, { signaller });
    const result = await orch.signalCredentialRefresh();
    expect(result.sent.sort()).toEqual(["aware-1", "aware-2"]);
    expect(result.skipped).toEqual(["unaware"]);
    expect(seen.map((x) => x.signal)).toEqual(["SIGHUP", "SIGHUP"]);

    await orch.shutdown();
  });

  it("supports targeted signal delivery (subset of integrations)", async () => {
    const a = makeChild();
    const b = makeChild();
    const signaller: SignalDispatcher = {
      async signal() {
        return true;
      },
    };

    const orch = await spawnIntegrations(
      [
        {
          integrationId: "aware-1",
          namespace: "a",
          afpsAware: true,
          spawn: async () => a.handle,
        },
        {
          integrationId: "aware-2",
          namespace: "b",
          afpsAware: true,
          spawn: async () => b.handle,
        },
      ],
      { signaller },
    );

    const result = await orch.signalCredentialRefresh(["aware-2"]);
    expect(result.sent).toEqual(["aware-2"]);
    expect(result.skipped).toEqual([]);

    await orch.shutdown();
  });

  it("returns all integrations as skipped when no signaller is wired", async () => {
    const a = makeChild();
    const orch = await spawnIntegrations([
      {
        integrationId: "aware-1",
        namespace: "g",
        afpsAware: true,
        spawn: async () => a.handle,
      },
    ]);
    const result = await orch.signalCredentialRefresh();
    expect(result.sent).toEqual([]);
    expect(result.skipped).toEqual(["aware-1"]);
    await orch.shutdown();
  });

  it("treats signaller throwing as skipped (non-fatal)", async () => {
    const a = makeChild();
    const signaller: SignalDispatcher = {
      async signal() {
        throw new Error("ESRCH");
      },
    };
    const orch = await spawnIntegrations(
      [
        {
          integrationId: "aware-1",
          namespace: "g",
          afpsAware: true,
          spawn: async () => a.handle,
        },
      ],
      { signaller },
    );
    const result = await orch.signalCredentialRefresh();
    expect(result.sent).toEqual([]);
    expect(result.skipped).toEqual(["aware-1"]);
    await orch.shutdown();
  });
});

describe("spawnIntegrations — telemetry passthrough", () => {
  it("annotates supervisor events with integrationId + namespace", async () => {
    const events: IntegrationOrchestratorEvent[] = [];
    const child = makeChild();
    const orch = await spawnIntegrations(
      [
        {
          integrationId: "i1",
          namespace: "gmail",
          spawn: async () => child.handle,
        },
      ],
      { onEvent: (e) => events.push(e) },
    );
    const spawnEvent = events.find((e) => e.type === "spawn-success");
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent!.integrationId).toBe("i1");
    expect(spawnEvent!.namespace).toBe("gmail");
    await orch.shutdown();
  });
});

describe("spawnIntegrations — shutdown idempotence", () => {
  it("calling shutdown twice resolves both", async () => {
    const child = makeChild();
    const orch = await spawnIntegrations([
      { integrationId: "i", namespace: "n", spawn: async () => child.handle },
    ]);
    const a = orch.shutdown();
    const b = orch.shutdown();
    await Promise.all([a, b]);
    expect(child.killed).toBe(true);
  });
});
