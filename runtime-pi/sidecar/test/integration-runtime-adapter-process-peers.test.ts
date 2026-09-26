// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — runner uids and peer attribution (#1547).
 *
 * Every runner shares 127.0.0.1 with the sidecar, so a peer address names no
 * runner. Each runner is spawned on a uid of its own from the
 * `APPSTRATE_RUNNER_UIDS` pool instead, and the kernel's socket table names
 * the uid owning the client socket a listener's peer connected from.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { socketPeer } from "../helpers.ts";

import {
  createProcessIntegrationRuntimeAdapter,
  socketOwnerUid,
} from "../integration-runtime-adapter-process.ts";
import type { IntegrationRuntimeAdapter } from "../integration-runtime-adapter.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";
import {
  FIXTURE_RUNNER_UIDS,
  installPassthroughRunnerExec,
  type PassthroughRunnerExec,
} from "./helpers/runner-exec.ts";

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/** One `/proc/net/tcp` row in the kernel's layout. */
function row(sl: number, local: string, remote: string, st: string, uid: number): string {
  return (
    `${String(sl).padStart(4)}: ${local} ${remote} ${st} 00000000:00000000 00:00000000 ` +
    `00000000 ${String(uid).padStart(5)}        0 ${20000 + sl} 1 0000000000000000 20 4 30 10 -1`
  );
}

/** `127.0.0.1:<port>` as the kernel prints it on a little-endian host. */
const loopback = (port: number) => `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;

const LISTENER = 8080;
/** A loopback peer at `port` that reached the listener on 127.0.0.1:{@link LISTENER}. */
const peer = (port: number) => ({
  address: "127.0.0.1",
  port,
  listener: { address: "127.0.0.1", port: LISTENER },
});

describe("socketOwnerUid", () => {
  const table = [
    HEADER,
    // Same local end as the peer (SO_REUSEADDR), another connection: another remote.
    row(5, loopback(40000), loopback(9090), "01", 4343),
    row(0, loopback(LISTENER), "00000000:0000", "0A", 1000),
    // The accepted server-side socket: its REMOTE end is the peer.
    row(1, loopback(LISTENER), loopback(40000), "01", 1000),
    // A LISTEN socket whose local end equals the peer's.
    row(2, loopback(40000), "00000000:0000", "0A", 4242),
    // The runner's client socket.
    row(3, loopback(40000), loopback(LISTENER), "01", 1100),
    row(4, "0302010A:01BB", "0100007F:1F90", "01", 1234),
  ].join("\n");

  it("returns the uid of the ESTABLISHED row keyed by the connection's 4-tuple", () => {
    expect(socketOwnerUid(table, peer(40000))).toBe(1100);
    expect(
      socketOwnerUid(table, { ...peer(40000), listener: { address: "127.0.0.1", port: 9090 } }),
    ).toBe(4343);
  });

  it("decodes the address from the network-order u32 and the port from big hex", () => {
    expect(socketOwnerUid(table, { ...peer(443), address: "10.1.2.3" })).toBe(1234);
    expect(socketOwnerUid(table, { ...peer(443), address: "3.2.1.10" })).toBeUndefined();
  });

  it("finds nothing for an unknown end, a non-IPv4 address or an invalid port", () => {
    expect(socketOwnerUid(table, peer(40001))).toBeUndefined();
    expect(
      socketOwnerUid(table, { ...peer(40000), listener: { address: "127.0.0.1", port: 9091 } }),
    ).toBeUndefined();
    expect(socketOwnerUid(table, { ...peer(40000), address: "::1" })).toBeUndefined();
    expect(
      socketOwnerUid(table, { ...peer(40000), listener: { address: "::1", port: LISTENER } }),
    ).toBeUndefined();
    expect(socketOwnerUid(table, peer(70000))).toBeUndefined();
    expect(socketOwnerUid("", peer(40000))).toBeUndefined();
  });

  it.skipIf(!existsSync("/proc/net/tcp"))(
    "names this process's uid for a real loopback connection it accepted",
    async () => {
      const server = createServer();
      const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const client = connect((server.address() as AddressInfo).port, "127.0.0.1");
      try {
        const serverSide = await accepted;
        const connectionPeer = socketPeer(serverSide);
        expect(connectionPeer).toBeDefined();
        const procNetTcp = await readFile("/proc/net/tcp", "utf8");
        expect(socketOwnerUid(procNetTcp, connectionPeer!)).toBe(process.getuid?.());
      } finally {
        client.destroy();
        (await accepted).destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

function localSpec(integrationId: string): IntegrationSpawnSpec {
  return {
    integrationId,
    namespace: "thirdparty",
    sourceKind: "local",
    manifest: {
      name: integrationId,
      version: "1.0.0",
      server: { type: "bun", entry_point: "server.ts", packageId: `${integrationId}-mcp` },
    },
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

describe("process adapter — runner uids and peer attribution", () => {
  const FIRST = FIXTURE_RUNNER_UIDS.first;
  let bundleRoot: string;
  let runnerExec: PassthroughRunnerExec;
  let table: string;
  let readFails: boolean;
  let reads: number;
  let adapters: IntegrationRuntimeAdapter[];

  const readProcNetTcp = async () => {
    reads += 1;
    if (readFails) throw new Error("ENOENT: /proc/net/tcp");
    return table;
  };

  async function newAdapter(): Promise<IntegrationRuntimeAdapter> {
    const adapter = createProcessIntegrationRuntimeAdapter({ readProcNetTcp });
    adapters.push(adapter);
    await adapter.prepare("run-peers");
    return adapter;
  }

  /** SubprocessTransport spawns on `start()`, so nothing is launched here. */
  function spawn(adapter: IntegrationRuntimeAdapter, integrationId: string) {
    return adapter.spawn({
      runId: "run-peers",
      spec: localSpec(integrationId),
      bundleRoot,
      egress: null,
      workspaceHandle: null,
      onStderrLine: () => {},
    });
  }

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "appstrate-runner-peers-"));
    await writeFile(join(bundleRoot, "server.ts"), "process.exit(0);\n");
    runnerExec = await installPassthroughRunnerExec();
    table = HEADER;
    readFails = false;
    reads = 0;
    adapters = [];
  });

  afterEach(async () => {
    for (const adapter of adapters) await adapter.shutdown();
    await runnerExec.restore();
    await rm(bundleRoot, { recursive: true, force: true });
  });

  it("attributes each runner's sockets to its integration, uids allocated in pool order", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    await spawn(adapter, "@orga/b");
    table = [
      HEADER,
      row(0, loopback(40000), loopback(LISTENER), "01", FIRST),
      row(1, loopback(40001), loopback(LISTENER), "01", FIRST + 1),
    ].join("\n");
    const attribute = adapter.peerAttribution();
    expect(await attribute(peer(40000))).toBe("@orga/a");
    expect(await attribute(peer(40001))).toBe("@orga/b");
  });

  it("treats uids outside the pool as non-runners and refuses unregistered pool uids", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    table = [
      HEADER,
      row(0, loopback(40001), loopback(LISTENER), "01", 1000), // the agent
      row(1, loopback(40002), loopback(LISTENER), "01", 0), // root
      row(2, loopback(40003), loopback(LISTENER), "01", FIRST + 1), // no runner holds it
    ].join("\n");
    const attribute = adapter.peerAttribution();
    expect(await attribute(peer(40001))).toBeNull();
    expect(await attribute(peer(40002))).toBeNull();
    expect(await attribute(peer(40003))).toBeUndefined();
  });

  it("refuses a peer with no socket entry, or when the table cannot be read", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    const attribute = adapter.peerAttribution();
    expect(await attribute(peer(40009))).toBeUndefined();
    readFails = true;
    expect(await attribute(peer(40009))).toBeUndefined();
  });

  it("attributes no peer to a runner, without reading the table, when there is no pool", async () => {
    delete process.env.APPSTRATE_RUNNER_UIDS;
    const adapter = await newAdapter();
    expect(await adapter.peerAttribution()(peer(40000))).toBeNull();
    expect(reads).toBe(0);
  });

  it("throws once the pool is exhausted, naming its size", async () => {
    process.env.APPSTRATE_RUNNER_UIDS = `${FIRST}-${FIRST + 1}`;
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    await spawn(adapter, "@orga/b");
    const third = spawn(adapter, "@orga/c");
    await expect(third).rejects.toThrow(/exhausted/);
    await expect(third).rejects.toThrow(/all 2 uids/);
  });

  it("allocates no uid to a spawn refused at admission", async () => {
    process.env.APPSTRATE_RUNNER_UIDS = `${FIRST}-${FIRST}`;
    const adapter = await newAdapter();
    process.env.APPSTRATE_RUNNER_EXEC = join(bundleRoot, "no-such-wrapper");
    await expect(spawn(adapter, "@orga/refused")).rejects.toThrow(/refusing to spawn/);
    process.env.APPSTRATE_RUNNER_EXEC = runnerExec.path;
    await spawn(adapter, "@orga/a");
    table = [HEADER, row(0, loopback(40000), loopback(LISTENER), "01", FIRST)].join("\n");
    expect(await adapter.peerAttribution()(peer(40000))).toBe("@orga/a");
  });
});
