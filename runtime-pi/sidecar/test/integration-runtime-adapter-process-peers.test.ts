// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — runner uids and peer attribution (#1547).
 *
 * Every runner shares 127.0.0.1 with the sidecar, so a peer address names no
 * runner. Each runner is spawned on a uid of its own from the
 * `APPSTRATE_RUNNER_UIDS` pool instead, and the kernel's socket table names
 * the uid owning the client socket a listener's peer connected from. The
 * transparent egress plane (#779) serves a peer the policy of the runner that
 * attribution names.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EgressPolicy } from "@appstrate/afps-runtime/resolvers";

import { socketPeer } from "../helpers.ts";

import {
  createProcessIntegrationRuntimeAdapter,
  socketOwnerUid,
} from "../integration-runtime-adapter-process.ts";
import type {
  IntegrationRuntimeAdapter,
  RuntimeEgressContext,
} from "../integration-runtime-adapter.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";
import { _setLogSinkForTesting } from "../logger.ts";
import { buildQuery, exchange } from "./helpers/dns-query.ts";
import { createHermeticProcessAdapter } from "./helpers/hermetic-process-adapter.ts";
import {
  FIXTURE_RUNNER_UIDS,
  installPassthroughRunnerExec,
  type PassthroughRunnerExec,
} from "./helpers/runner-exec.ts";
import { buildClientHello } from "./helpers/tls-client-hello.ts";

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

let stopCapture = () => {};

/**
 * Collect the warn/error lines the sidecar logger emits until the next
 * `afterEach`. The suite preload pins `LOG_LEVEL=error`, which would drop every
 * `warn` before the sink sees it, so the capture lowers it to `warn`.
 */
function captureWarnings(): string[] {
  const lines: string[] = [];
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  _setLogSinkForTesting((level, line) => {
    if (level === "warn" || level === "error") lines.push(line);
  });
  stopCapture = () => {
    _setLogSinkForTesting(null);
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
    stopCapture = () => {};
  };
  return lines;
}

afterEach(() => stopCapture());

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
  /** Served, in order, before `table`: a read racing socket churn that skipped a row. */
  let staleTables: string[];
  let readFails: boolean;
  let reads: number;
  let adapters: IntegrationRuntimeAdapter[];

  const readProcNetTcp = async () => {
    reads += 1;
    if (readFails) throw new Error("ENOENT: /proc/net/tcp");
    return staleTables.shift() ?? table;
  };

  async function newAdapter(): Promise<IntegrationRuntimeAdapter> {
    const adapter = createHermeticProcessAdapter({ readProcNetTcp });
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
    staleTables = [];
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

  it("re-reads a table that missed the peer's row, and attributes it on a later read", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    staleTables = [HEADER];
    table = [HEADER, row(0, loopback(40000), loopback(LISTENER), "01", FIRST)].join("\n");
    expect(await adapter.peerAttribution()(peer(40000))).toBe("@orga/a");
    expect(reads).toBe(2);
  });

  it("refuses a peer no socket entry names after three reads", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    expect(await adapter.peerAttribution()(peer(40009))).toBeUndefined();
    expect(reads).toBe(3);
  });

  it("refuses at once, with a warning, when the table cannot be read", async () => {
    const warnings = captureWarnings();
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/a");
    readFails = true;
    expect(await adapter.peerAttribution()(peer(40009))).toBeUndefined();
    expect(reads).toBe(1);
    expect(warnings.join("\n")).toContain("runner peer lookup failed");
  });

  it("attributes no peer to a runner, without reading the table, before any spawn", async () => {
    const adapter = await newAdapter();
    expect(await adapter.peerAttribution()(peer(40000))).toBeNull();
    expect(reads).toBe(0);
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

  it("hands concurrent spawns distinct uids", async () => {
    const adapter = await newAdapter();
    await Promise.all([spawn(adapter, "@orga/a"), spawn(adapter, "@orga/b")]);
    table = [
      HEADER,
      row(0, loopback(40000), loopback(LISTENER), "01", FIRST),
      row(1, loopback(40001), loopback(LISTENER), "01", FIRST + 1),
    ].join("\n");
    const attribute = adapter.peerAttribution();
    const owners = [await attribute(peer(40000)), await attribute(peer(40001))];
    expect(owners.sort()).toEqual(["@orga/a", "@orga/b"]);
  });
});

/** Whether `port` on 127.0.0.1 can be bound right now (nothing holds it). */
async function bindable(kind: "tcp" | "udp", port: number): Promise<boolean> {
  if (kind === "tcp") {
    const server = createServer();
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (bound) await new Promise<void>((resolve) => server.close(() => resolve()));
    return bound;
  }
  const socket = createSocket("udp4");
  const bound = await new Promise<boolean>((resolve) => {
    socket.once("error", () => resolve(false));
    socket.bind(port, "127.0.0.1", () => resolve(true));
  });
  if (bound) await new Promise<void>((resolve) => socket.close(() => resolve()));
  return bound;
}

/** A port on 127.0.0.1 nothing holds, for the plane to bind in place of 53/443/80. */
async function freePort(kind: "tcp" | "udp"): Promise<number> {
  if (kind === "tcp") {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

describe("process adapter — transparent egress plane (#779)", () => {
  const FIRST = FIXTURE_RUNNER_UIDS.first;
  const ALLOWED = "api.allowed.test";
  const policy: EgressPolicy = {
    allowsAuthority: (host) => host === ALLOWED,
    allowsUrl: () => true,
  };
  const connectEgress: RuntimeEgressContext = {
    proxyUrl: "http://127.0.0.1:1",
    caCertHostPath: null,
    policy,
  };
  /** The adapter opens the CA's directory to the runner, so it must be a real one. */
  const mitmEgress = (): RuntimeEgressContext => ({
    ...connectEgress,
    caCertHostPath: join(bundleRoot, "ca.pem"),
  });

  let bundleRoot: string;
  let runnerExec: PassthroughRunnerExec;
  let adapters: IntegrationRuntimeAdapter[];
  let ports: { dns: number; tls: number; http: number };
  let upstream: { server: Server; port: number; received: Buffer[]; sockets: Socket[] };
  /** Loopback client port → the uid the socket table says owns it. */
  let owners: Map<number, { uid: number; listenerPort: number }>;
  /** Settles once the current client's port is in `owners` (it connects before the plane reads). */
  let registered: Promise<void>;

  const readProcNetTcp = async () => {
    await registered;
    return [
      HEADER,
      ...[...owners].map(([port, { uid, listenerPort }], sl) =>
        row(sl, loopback(port), loopback(listenerPort), "01", uid),
      ),
    ].join("\n");
  };

  async function newAdapter(): Promise<IntegrationRuntimeAdapter> {
    const adapter = createProcessIntegrationRuntimeAdapter({
      readProcNetTcp,
      transparentPlane: {
        ports,
        splicer: {
          upstreamPort: upstream.port,
          isBlockedHostFn: () => false,
          resolveHostFn: async () => ["127.0.0.1"],
        },
      },
    });
    adapters.push(adapter);
    await adapter.prepare("run-plane");
    return adapter;
  }

  function spawn(
    adapter: IntegrationRuntimeAdapter,
    integrationId: string,
    egress: RuntimeEgressContext,
  ) {
    return adapter.spawn({
      runId: "run-plane",
      spec: localSpec(integrationId),
      bundleRoot,
      egress,
      workspaceHandle: null,
      onStderrLine: () => {},
    });
  }

  /** Send `bytes` to the plane as `uid`; resolves with what came back once echoed or closed. */
  function sendAs(uid: number, listenerPort: number, bytes: Buffer): Promise<Buffer> {
    let markRegistered!: () => void;
    registered = new Promise((resolve) => (markRegistered = resolve));
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const finish = () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(finish, 3_000);
      const socket = connect(listenerPort, "127.0.0.1", () => {
        owners.set(socket.localPort!, { uid, listenerPort });
        markRegistered();
        socket.write(bytes);
      });
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length >= bytes.length) finish();
      });
      socket.on("close", finish);
      socket.on("error", finish);
    });
  }

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "appstrate-runner-plane-"));
    await writeFile(join(bundleRoot, "server.ts"), "process.exit(0);\n");
    runnerExec = await installPassthroughRunnerExec();
    adapters = [];
    owners = new Map();
    registered = Promise.resolve();
    ports = { dns: await freePort("udp"), tls: await freePort("tcp"), http: await freePort("tcp") };
    const received: Buffer[] = [];
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        socket.write(chunk);
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    upstream = { server, port: (server.address() as AddressInfo).port, received, sockets };
  });

  afterEach(async () => {
    for (const adapter of adapters) await adapter.shutdown();
    for (const socket of upstream.sockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    await runnerExec.restore();
    await rm(bundleRoot, { recursive: true, force: true });
  });

  /** Whether the plane holds its three ports (all three, or none). */
  async function planeUp(): Promise<boolean> {
    const free = [
      await bindable("udp", ports.dns),
      await bindable("tcp", ports.tls),
      await bindable("tcp", ports.http),
    ];
    expect(new Set(free).size).toBe(1);
    return !free[0];
  }

  it("answers the runners' DNS with 127.0.0.1, and warns about nothing", async () => {
    const warnings = captureWarnings();
    await spawn(await newAdapter(), "@orga/connect", connectEgress);
    expect(warnings).toEqual([]);
    const reply = await exchange(ports.dns, buildQuery(ALLOWED, 1));
    expect(reply).not.toBeNull();
    expect([...reply!.subarray(-4)]).toEqual([127, 0, 0, 1]);
  });

  it("splices a plain-CONNECT runner's TLS and plain HTTP to a host its policy allows", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/connect", connectEgress);
    const hello = buildClientHello(ALLOWED);
    expect((await sendAs(FIRST, ports.tls, hello)).equals(hello)).toBe(true);
    const request = Buffer.from(`GET / HTTP/1.1\r\nHost: ${ALLOWED}\r\n\r\n`);
    expect((await sendAs(FIRST, ports.http, request)).equals(request)).toBe(true);
    expect(Buffer.concat(upstream.received).equals(Buffer.concat([hello, request]))).toBe(true);
  });

  it("refuses a MITM-delivery runner, a non-runner peer and a host outside the policy", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/connect", connectEgress);
    await spawn(adapter, "@orga/mitm", mitmEgress());
    const hello = buildClientHello(ALLOWED);
    expect(await sendAs(FIRST + 1, ports.tls, hello)).toHaveLength(0);
    expect(await sendAs(1000, ports.tls, hello)).toHaveLength(0);
    expect(await sendAs(FIRST, ports.tls, buildClientHello("evil.test"))).toHaveLength(0);
    expect(upstream.received).toHaveLength(0);
  });

  it("starts no plane at prepare, nor for a MITM-delivery runner", async () => {
    const adapter = await newAdapter();
    expect(await planeUp()).toBe(false);
    await spawn(adapter, "@orga/mitm", mitmEgress());
    expect(await planeUp()).toBe(false);
  });

  it("starts the plane once, on the first plain-CONNECT spawns, even concurrent ones", async () => {
    const warnings = captureWarnings();
    const adapter = await newAdapter();
    await Promise.all([
      spawn(adapter, "@orga/a", connectEgress),
      spawn(adapter, "@orga/b", connectEgress),
    ]);
    // A second start would fail to bind the ports the first holds, and warn.
    expect(warnings).toEqual([]);
    expect(await planeUp()).toBe(true);
  });

  it("closes the plane on shutdown, idempotently", async () => {
    const adapter = await newAdapter();
    await spawn(adapter, "@orga/connect", connectEgress);
    expect(await planeUp()).toBe(true);
    await adapter.shutdown();
    await adapter.shutdown();
    expect(await planeUp()).toBe(false);
  });
});
