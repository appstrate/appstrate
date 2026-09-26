// SPDX-License-Identifier: Apache-2.0

/**
 * Fourth smoke VM (#1547) — integration runner egress on the real guest kernel.
 *
 * The REAL in-guest sidecar boots three local integrations (specs through the
 * ordinary `SidecarLaunchSpec.integrations` → INTEGRATIONS_TO_SPAWN_JSON path,
 * bundle and MITM credential fetched from the smoke's platform stub) whose
 * runners are one probe MCP server (`runner-egress-probes/runner.js`) in three
 * roles: two plain-CONNECT runners with disjoint allowlists and one
 * `delivery.http` (MITM) runner. The agent argv is the probe counterpart
 * (`runner-egress-probes/agent.js`).
 *
 * Each runner must land on its own pool uid with a private group, HOME and
 * umask, no permitted/effective/ambient capability and no_new_privs set; list
 * /workspace only when it opted in; have no direct egress, TCP or UDP; reach
 * only its `authorized_uris` through its own listener and — for a
 * plain-CONNECT runner only, under ITS policy — through the transparent plane;
 * and be refused by the agent's forward proxy and by a sibling's listener. The
 * agent must keep its forward proxy once runners exist, be refused by the
 * runners' listeners and the transparent plane, be unable to list the MITM
 * listener's private socket dir, and see no sidecar TCP listener beyond the
 * known set. A refusal is judged by its SHAPE, not merely as a failure: a
 * CONNECT listener's policy answers `403`, the transparent plane and the MITM
 * listener reset the TLS handshake — a timeout is never a refusal.
 *
 * Every probe prints a raw observation — `RUNNER_EGRESS_1547 <reporter>.<probe>=
 * <value>`, on the serial console, by the agent only — and every verdict is
 * taken HERE: a probe that did not run, or ran against the wrong target, fails
 * instead of passing by default, and each denial is asserted next to its
 * allowed twin (same route with an allowed target, or the same target from its
 * owner), since an error alone could be a broken route rather than a refusal.
 *
 * The probe programs are plain JavaScript files run by the guest's `bun`; they
 * are bundled here at smoke start (`Bun.build`, one self-contained file each)
 * and take every setting from `PROBE_*` env set below — this module is the one
 * copy of every port, timeout and the marker tag.
 *
 * REQUIRES INTERNET ACCESS from the KVM host: the guest's sidecar dials
 * example.com / example.org (the Lima dev VM and GitHub-hosted runners have it).
 */

import { SIDECAR_AUTH_HEADER, type IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { zipSync } from "fflate";
import { join } from "node:path";

import {
  GUEST_RUNNER_UID_COUNT,
  GUEST_RUNNER_UID_FIRST,
  GUEST_SIDECAR_UID,
} from "../../guest/firewall.ts";
import type { FirecrackerOrchestrator } from "../../orchestrator.ts";
import { TAP_DEVICE_PREFIX } from "../../subnet.ts";

// ---------------------------------------------------------------------------
// Timing. Generous on purpose: this smoke also runs under NESTED
// virtualization (Lima → Firecracker). One observed run there had the agent
// start ~2 s after guest boot, but the sidecar's first log line at +232 s, its
// forward proxy at +264 s and the transparent plane at +306 s; the sidecar then
// boots the three probe runners one after the other (each a cold `bun` start
// whose MCP handshake has exceeded 30 s), and every child `bun -e` probe is
// another cold start. Every wait below is a BOUND, not a sleep — it ends as
// soon as its condition holds — so an L1 KVM host (CI) pays nothing for it.
// ---------------------------------------------------------------------------
/** Host: VMM spawn → the agent process starts (kernel, init, supervisor). */
const AGENT_START_BUDGET_MS = 60_000;
/** Agent: sidecar `/health` 200 AND its forward proxy accepting, before ANY control runs. */
const SIDECAR_READY_WAIT_MS = 360_000;
/**
 * Agent: the sidecar's integration boot report, i.e. the end of the runners'
 * sequential spawns (each bounded by the sidecar's fixed 30 s MCP connect, plus
 * the bundle fetch). Waited for concurrently with the agent's controls.
 */
const BOOT_REPORT_WAIT_MS = 300_000;
/**
 * Agent: every spawned runner's final report, measured from the boot report —
 * the gate opens there, so this covers the probes only: a runner's children
 * are sequential (2 × CHILD_TIMEOUT_MS at most), its fetches run beside them
 * (FETCH_TIMEOUT_MS each), plus the report delivery.
 */
const RUNNERS_WAIT_MS = 420_000;
/**
 * Agent: its controls (platform, forward-proxy CONNECT, full TLS control) plus
 * its post-report probes — a handful of exchanges, each bounded by
 * FETCH_TIMEOUT_MS at most.
 */
const AGENT_PROBES_BUDGET_MS = 420_000;
/** Host: VMM spawn → exit marker, the sum of the agent's phases. */
const VM_TIMEOUT_MS =
  AGENT_START_BUDGET_MS +
  SIDECAR_READY_WAIT_MS +
  BOOT_REPORT_WAIT_MS +
  RUNNERS_WAIT_MS +
  AGENT_PROBES_BUDGET_MS;
/** Runner: retrying its report to the agent, a peer-address query, or the start gate. */
const PEER_WAIT_MS = 240_000;
/**
 * Runner: its probes wait for the sidecar's `tools/list` (the end of the MCP
 * connect, which the sidecar bounds at a fixed 30 s — probing during it made
 * runners miss it under nested virt). Past this, the runner probes anyway and
 * reports `handshake=timeout`, which fails the host check.
 */
const HANDSHAKE_WAIT_MS = 60_000;
/**
 * One probe fetch, TLS handshake or DNS query (runner and agent). Under nested
 * virt (an arm64 L2 guest) bun's TLS is 15-20× slower than on L1 — a full
 * handshake + certificate verification overran 20 s there. A DENIAL is a fast
 * reset or status, so the generous bound costs nothing on a working host.
 */
const FETCH_TIMEOUT_MS = 90_000;
/** One child `bun -e` probe: its cold start, then one fetch of FETCH_TIMEOUT_MS. */
const CHILD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Wire constants shared with the guest programs (through PROBE_* env).
// ---------------------------------------------------------------------------
const TAG = "RUNNER_EGRESS_1547";
/** Stub path runner r1 dials DIRECTLY — its hit count must stay 0. */
const DIRECT_PATH = "/runner-egress-1547/direct";
/** Stub path the agent dials (it may) — proves the counter and the route work. */
const CONTROL_PATH = "/runner-egress-1547/control";
/** The mcp-server package every probe integration references (bundle served by the stub). */
const SERVER_PACKAGE = "@smoke/runner-egress-probe-server";
const BUNDLE_PATH = `/internal/mcp-server-bundle/${SERVER_PACKAGE}`;
/** The `delivery.http` integration whose credential the stub serves (MITM runner). */
const MITM_INTEGRATION = "@smoke/runner-egress-mitm";
/**
 * The agent↔sidecar bearer for this VM (fake). The agent needs it to read
 * `GET /integrations/boot-report`; it rides the agent env as SIDECAR_AUTH_TOKEN,
 * which the credential split brokers through MMDS, never the config drive.
 */
const SIDECAR_AUTH_TOKEN = "smoke-sidecar-auth-1547-5EC0DE";
const CREDENTIALS_PATH = `/internal/integration-credentials/${MITM_INTEGRATION}`;
/** Loopback port of the agent's report channel. */
const DONE_PORT = 18547;
/** UDP port on the platform alias the runners' datagrams aim at (not 53: no redirect). */
const UDP_PORT = 18548;
/** The host's own datagram to that port: proves the smoke's UDP counter counts. */
const UDP_CONTROL_PAYLOAD = "runner-egress-1547 host-control";
/** The smoke's own host nftables table (inet), counting UDP_PORT datagrams at prerouting. */
const UDP_TABLE = "smoke1547";
/**
 * Reporter ids, in spawn order (the sidecar boots specs sequentially):
 *   r1   plain-CONNECT runner allowed https://example.com (the #1458 probes)
 *   r2   plain-CONNECT runner allowed https://example.org only, opted into the
 *        workspace — the cross-runner attribution probe, the per-runner plane
 *        policy probe, and the positive `workspace` control
 *   mitm `delivery.http` runner (MITM listener, header injected) allowed
 *        https://example.com/**
 */
const IDS = ["r1", "r2", "mitm"] as const;
type RunnerId = (typeof IDS)[number];
/** Each reporter's integration id — how the sidecar's boot report names it. */
const INTEGRATION_OF: Record<RunnerId, string> = {
  r1: "@smoke/runner-egress-probe",
  r2: "@smoke/runner-egress-cross",
  mitm: MITM_INTEGRATION,
};
/**
 * Guest-side ports the sidecar pins — `FirecrackerOrchestrator.createSidecar`
 * passes `port: "8080"` / `forwardProxyPort: "8081"`, asserted against the
 * captured sidecar env before boot so a change there cannot silently point the
 * probes (and the listener-set assertion) at dead ports.
 */
const GUEST_SIDECAR_PORT = 8080;
const GUEST_FORWARD_PROXY_PORT = 8081;
/** The transparent plane's splicers (`startTransparentEgressPlane` defaults). */
const GUEST_TRANSPARENT_TLS_PORT = 443;
const GUEST_TRANSPARENT_HTTP_PORT = 80;
/** The `workspace` group (Dockerfile.rootfs, runner-exec.c WORKSPACE_GID). */
const GUEST_WORKSPACE_GID = 1003;

/** The MITM runner's header credential (fake; example.com ignores it). */
const MITM_AUTH_KEY = "smoke_key";
const MITM_HEADER = "X-Smoke-Credential";
const MITM_VALUE = "smoke-mitm-credential-0C0FFEE";
const MITM_URIS = ["https://example.com/**"];

/**
 * What the stub answers on `GET /internal/integration-credentials/<mitm id>` —
 * the platform's snake_case wire (normalizeIntegrationCredentialsWire in
 * runtime-pi/sidecar/integration-credentials-source.ts).
 */
const MITM_CREDENTIALS = {
  auths: [
    {
      auth_key: MITM_AUTH_KEY,
      auth_type: "api_key",
      fields: { api_key: MITM_VALUE },
      authorized_uris: MITM_URIS,
    },
  ],
  delivery_plans: {
    [MITM_AUTH_KEY]: {
      header_name: MITM_HEADER,
      header_prefix: "",
      value: MITM_VALUE,
      allow_server_override: false,
    },
  },
  expires_at_epoch_ms: { [MITM_AUTH_KEY]: null },
};

/** A refusal that must come from a permission check, not from a missing target. */
const PERMISSION_DENIED = /^error:(EACCES|EPERM)$/;

const PROBES_DIR = join(import.meta.dir, "runner-egress-probes");

type Fail = (msg: string) => never;

interface StubHits {
  bundle: number;
  direct: number;
  control: number;
  credentials: number;
}

interface RunnerEgressVmOptions {
  /** The platform alias the guest reaches the stub on (bound by `initialize()`). */
  aliasIp: string;
  platformPort: number;
  fail: Fail;
}

interface RunnerEgressVmRunDeps {
  orch: FirecrackerOrchestrator;
  runId: string;
  runToken: string;
  dumpConsole: (runDir: string, label: string) => Promise<void>;
  withExitTimeout: <T>(promise: Promise<T>, message: string, timeoutMs: number) => Promise<T>;
}

interface RunnerEgressVm {
  /** The platform-stub routes this VM needs; `undefined` when `req` is not one of them. */
  handleStubRequest(req: Request): Response | undefined;
  /** Boot the fourth VM, take every verdict, tear it down. Needs `initialize()` done. */
  run(deps: RunnerEgressVmRunDeps): Promise<void>;
}

/** What `createRunnerEgressVm` prepares once, for the run and its verdicts. */
interface RunnerEgressContext {
  aliasIp: string;
  fail: Fail;
  hits: StubHits;
  integrations: IntegrationSpawnSpec[];
  /** The bundled agent program, run as `bun -e`. */
  agentJs: string;
  agentEnv: Record<string, string>;
}

interface UdpCounter {
  /** Guest datagrams to UDP_PORT counted so far. */
  readGuest(): Promise<number>;
  close(): Promise<void>;
}

/** Bundle one guest probe program with the helpers it imports into one ESM file. */
async function bundleProbe(file: string, fail: Fail): Promise<string> {
  const entry = join(PROBES_DIR, file);
  const build = Bun.build({ entrypoints: [entry], target: "bun" });
  const result = await build.catch((err: unknown) =>
    fail(`could not bundle the #1547 probe ${entry}: ${String(err)}`),
  );
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    fail(`could not bundle the #1547 probe ${entry}: ${result.logs.map(String).join("; ")}`);
  }
  return output.text();
}

/** A local integration running the probe bundle (the stub serves one bundle for all). */
function probeIntegration(
  integrationId: string,
  namespace: string,
  extra: Omit<IntegrationSpawnSpec, "integrationId" | "namespace" | "sourceKind" | "manifest">,
): IntegrationSpawnSpec {
  return {
    integrationId,
    namespace,
    sourceKind: "local",
    manifest: {
      name: integrationId,
      version: "1.0.0",
      server: { type: "bun", entry_point: "server.js", packageId: SERVER_PACKAGE },
    },
    ...extra,
  };
}

/**
 * The three integrations the sidecar boots, in spawn order. r1 and r2 carry NO
 * credentials (no delivery.http, no api_call ⇒ plain-CONNECT listener); mitm
 * declares `delivery.http`, so the sidecar mints the run CA, fetches its
 * credential from the stub and mounts a MITM listener instead.
 */
function probeIntegrations(aliasIp: string, platformPort: number): IntegrationSpawnSpec[] {
  const env = (id: RunnerId, role: string): Record<string, string> => ({
    PROBE_TAG: TAG,
    PROBE_RUNNER_ID: id,
    PROBE_ROLE: role,
    PROBE_DONE_PORT: String(DONE_PORT),
    PROBE_PEER_WAIT_MS: String(PEER_WAIT_MS),
    PROBE_HANDSHAKE_WAIT_MS: String(HANDSHAKE_WAIT_MS),
    PROBE_CHILD_TIMEOUT_MS: String(CHILD_TIMEOUT_MS),
    PROBE_FETCH_TIMEOUT_MS: String(FETCH_TIMEOUT_MS),
    PROBE_UID_FIRST: String(GUEST_RUNNER_UID_FIRST),
    PROBE_UID_COUNT: String(GUEST_RUNNER_UID_COUNT),
    PROBE_PLATFORM_HOST: aliasIp,
    PROBE_PLATFORM_PORT: String(platformPort),
    PROBE_UDP_PORT: String(UDP_PORT),
    PROBE_TRANSPARENT_TLS_PORT: String(GUEST_TRANSPARENT_TLS_PORT),
  });
  return [
    probeIntegration(INTEGRATION_OF.r1, "runner_egress_probe", {
      spawnEnv: {
        ...env("r1", "connect"),
        PROBE_DIRECT_PATH: DIRECT_PATH,
        PROBE_AGENT_PROXY_PORT: String(GUEST_FORWARD_PROXY_PORT),
      },
      egress: { authorizedUris: ["https://example.com"], allowAllUris: false },
    }),
    probeIntegration(INTEGRATION_OF.r2, "runner_egress_cross", {
      spawnEnv: { ...env("r2", "cross"), PROBE_PEER_ID: "r1" },
      egress: { authorizedUris: ["https://example.org"], allowAllUris: false },
      // Opt-in: the positive control for the `workspace` group and the
      // /workspace listing (r1/mitm must lack both).
      workspaceMount: { mount: "/workspace", access: "rw" },
    }),
    probeIntegration(INTEGRATION_OF.mitm, "runner_egress_mitm", {
      spawnEnv: env("mitm", "mitm"),
      egress: { authorizedUris: MITM_URIS, allowAllUris: false },
      httpDeliveryAuths: {
        [MITM_AUTH_KEY]: {
          authType: "api_key",
          headerName: MITM_HEADER,
          headerPrefix: "",
          value: MITM_VALUE,
          allowServerOverride: false,
          authorizedUris: MITM_URIS,
          expiresAtEpochMs: null,
        },
      },
    }),
  ];
}

/** Run `nft` on the host (the smoke runs as root, like the orchestrator), `script` on stdin. */
async function nft(
  args: string[],
  script?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["nft", ...args], {
    stdin: script === undefined ? "ignore" : new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** A named counter's packet count in the smoke's table, or `undefined` if unreadable. */
async function udpCounterPackets(name: string): Promise<number | undefined> {
  const listed = await nft(["list", "counter", "inet", UDP_TABLE, name]);
  const packets = /packets (\d+)/.exec(listed.out)?.[1];
  return listed.code === 0 && packets !== undefined ? Number(packets) : undefined;
}

/**
 * The guest-UDP counter, live for the VM's lifetime: a dedicated inet table
 * whose prerouting chain, at priority raw (ahead of conntrack and of any
 * filter chain that could drop the packet first, the orchestrator's
 * `appstrate_fc` included), counts every datagram to UDP_PORT arriving on a
 * guest TAP. It accepts nothing: the count is taken before any host verdict,
 * so a zero says the GUEST firewall kept the datagram in. The host's own
 * datagram to the platform alias loops back over `lo` through the same hook
 * into a twin counter — the control that this table counts on this host. The
 * caller deletes the table in its `finally`;
 * a table left by a crashed run is replaced (with its counts) here.
 */
async function openUdpCounter(aliasIp: string, fail: Fail): Promise<UdpCounter> {
  const script = [
    `add table inet ${UDP_TABLE}`,
    `delete table inet ${UDP_TABLE}`,
    `table inet ${UDP_TABLE} {`,
    "  counter guest {}",
    "  counter host_control {}",
    "  chain pre {",
    "    type filter hook prerouting priority raw; policy accept;",
    `    iifname "${TAP_DEVICE_PREFIX}*" udp dport ${UDP_PORT} counter name guest`,
    `    iifname "lo" ip daddr ${aliasIp} udp dport ${UDP_PORT} counter name host_control`,
    "  }",
    "}",
    "",
  ].join("\n");
  // A host-side sink bound on the destination: Bun (1.3.14) crashes at process
  // exit when a UDP socket's datagram draws an ICMP port-unreachable.
  const sink = await Bun.udpSocket({ hostname: aliasIp, port: UDP_PORT }).catch((err: unknown) =>
    fail(`could not bind the UDP sink on ${aliasIp}:${UDP_PORT}: ${String(err)}`),
  );
  const created = await nft(["-f", "/dev/stdin"], script);
  if (created.code !== 0) {
    sink.close();
    fail(
      `could not create the smoke's UDP counter table inet ${UDP_TABLE} (nft exit ` +
        `${created.code}): ${created.err.trim()}`,
    );
  }
  const close = async () => {
    sink.close();
    await nft(["delete", "table", "inet", UDP_TABLE]);
  };

  try {
    const client = await Bun.udpSocket({});
    client.send(UDP_CONTROL_PAYLOAD, UDP_PORT, aliasIp);
    let control = 0;
    for (let i = 0; i < 40 && control === 0; i++) {
      await Bun.sleep(50);
      control = (await udpCounterPackets("host_control")) ?? 0;
    }
    client.close();
    if (control === 0) {
      fail(
        `the smoke's prerouting counter (table inet ${UDP_TABLE}) never counted the host's own ` +
          `datagram to ${aliasIp}:${UDP_PORT} — a zero guest count below would be vacuous`,
      );
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    async readGuest() {
      const guest = await udpCounterPackets("guest");
      if (guest === undefined) {
        fail(`could not read the guest UDP counter in table inet ${UDP_TABLE}`);
      }
      return guest;
    },
    close,
  };
}

/**
 * A marker as the AGENT printed it. The runners' stderr copies carry another
 * prefix (`runner-egress-diag`), so this can only match an agent-printed line.
 */
function marker(log: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${TAG} ${escaped}=([A-Za-z0-9_.:,/-]+)`).exec(log)?.[1];
}

/** Every probe verdict, taken host-side from the raw observations on the console. */
function assertRunnerEgress(log: string, ctx: RunnerEgressContext, udpGuest: number): void {
  const fail: Fail = ctx.fail;
  const { aliasIp, hits } = ctx;
  const need = (key: string): string => {
    const value = marker(log, key);
    if (value === undefined) {
      fail(`#1547 probe '${key}' never reported on the console (agent-printed lines only)`);
    }
    return value;
  };
  // Allowed and refused, each next to its twin. A refusal must be the policy's
  // own answer, not any failure: a timeout or an unrelated error could be a
  // broken route that proves nothing.
  const isSuccess = (v: string) => /^[23]\d\d$/.test(v);
  /**
   * A fetch through a plain-CONNECT listener its policy refused: the
   * listener's `403 Forbidden` to the CONNECT (integration-egress-listener.ts),
   * surfaced by Bun's fetch as the status.
   */
  const isProxy403 = (v: string) => v === "403";
  /**
   * The transparent plane's refusal: it drops a denied peer or SNI after
   * reading the ClientHello (integration-transparent-listener.ts). A
   * reset-class error — ECONNRESET, or the verification error Bun's fetch
   * reports for a reset during its handshake. Never a timeout.
   */
  const isResetRefusal = (v: string) =>
    /^error:(ECONNRESET|UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)$/.test(v);
  /** A raw CONNECT exchange: the status it got, if any. */
  const connectStatus = (v: string) => /^HTTP\/1\.[01]_(\d{3})/.exec(v)?.[1];
  const isConnect200 = (v: string) => connectStatus(v) === "200";
  /** A raw CONNECT refused by the listener's peer attribution: exactly `403`. */
  const isConnect403 = (v: string) => connectStatus(v) === "403";
  /** A probe's diagnostic markers, for a failure message: ` [ms=… lookup=… detail=…]`. */
  const diag = (key: string): string => {
    const extras = ["ms", "fetchms", "lookup", "detail"]
      .map((field) => [field, marker(log, `${key}-${field}`)] as const)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => `${field}=${value}`);
    return extras.length > 0 ? ` [${extras.join(" ")}]` : "";
  };

  // --- 0. Plumbing: the sidecar fetched the bundle and became ready before
  //        any control ran.
  if (hits.bundle === 0) {
    fail(
      "the sidecar never fetched the probe mcp-server bundle — INTEGRATIONS_TO_SPAWN_JSON did " +
        "not reach it, or the integration boot failed before the fetch",
    );
  }
  const ready = need("agent.sidecar-ready");
  if (!/^\d+$/.test(ready)) {
    fail(
      `the sidecar never became ready for the agent within ${SIDECAR_READY_WAIT_MS / 1000}s ` +
        `(${ready}: last /health status, last forward-proxy connect) — no control ran`,
    );
  }

  // --- The sidecar's integration boot: which runners spawned. Everything the
  //     spawned runners and the agent reported is judged first; a runner whose
  //     spawn failed is reported LAST, with the sidecar's own reason, so one
  //     run shows every result. Without a boot report (the gate opened on its
  //     timeout) every runner is judged, and the missing report fails last.
  const bootReport = need("agent.boot-report");
  const boot = /^spawned:([a-z0-9,]*)\/failed:([a-z0-9,]*)$/.exec(bootReport);
  const bootSpawned = (boot?.[1] ?? "").split(",");
  const bootFailed = (boot?.[2] ?? "").split(",");
  const live: RunnerId[] = boot ? IDS.filter((id) => bootSpawned.includes(id)) : [...IDS];
  const has = (id: RunnerId) => live.includes(id);
  const bootFailures: string[] = boot
    ? []
    : [`the agent never read the sidecar's integration boot report (${bootReport})`];
  for (const id of IDS) {
    if (has(id)) continue;
    const error = bootFailed.includes(id)
      ? (marker(log, `agent.boot-error-${id}`) ?? "no reason reported")
      : "absent from the boot report";
    const hint = /connect_timeout/i.test(error)
      ? " — the runner's cold start exceeded the sidecar's MCP handshake budget"
      : "";
    bootFailures.push(`${id}: ${error}${hint}`);
  }
  const done = need("agent.runners-done");
  if (done !== "signalled") {
    fail(
      `not every spawned probe runner (${live.join(",")}) delivered its final report within ` +
        `${RUNNERS_WAIT_MS / 1000}s of the boot report (${done}) — it hung or was reaped; see ` +
        "the sidecar's 'integration' and 'runner-egress-diag' lines above",
    );
  }

  // --- Probe scheduling: each runner answered the sidecar's `tools/list`
  //     before probing, and none probed before the integration boot finished
  //     — a runner probing during a connect budget could be torn down, and
  //     every functional refusal below would then be a dead listener.
  for (const id of live) {
    const handshake = need(`${id}.handshake`);
    if (handshake !== "tools-list") {
      fail(
        `runner ${id} never received the sidecar's tools/list (${handshake}) although the ` +
          "boot report lists it as spawned",
      );
    }
    const gate = need(`${id}.start-gate`);
    if (gate !== "open") {
      fail(`runner ${id} started probing before the sidecar's integration boot finished (${gate})`);
    }
  }

  // --- 5. Identity hygiene, per runner.
  const lastUid = GUEST_RUNNER_UID_FIRST + GUEST_RUNNER_UID_COUNT - 1;
  const uids = new Map<RunnerId, number>();
  const listenerPorts = new Map<RunnerId, number>();
  /** Each runner's unjudged capability sets (inheritable, bounding), for the summary. */
  const capReport: string[] = [];
  for (const id of live) {
    const uid = Number(need(`${id}.uid`));
    if (!(uid >= GUEST_RUNNER_UID_FIRST && uid <= lastUid)) {
      fail(
        `runner ${id} runs as uid ${uid}, outside the pool ${GUEST_RUNNER_UID_FIRST}-${lastUid} ` +
          "— the setuid wrapper did not drop it onto a runner uid",
      );
    }
    uids.set(id, uid);
    for (const probe of ["gid", "egid"]) {
      const gid = need(`${id}.${probe}`);
      if (Number(gid) !== uid) {
        fail(`runner ${id} (uid ${uid}) has ${probe} ${gid} — expected its private group ${uid}`);
      }
    }
    // Capabilities: the sidecar runs with ambient CAP_NET_BIND_SERVICE +
    // CAP_KILL, and none may follow a runner across the setuid wrapper.
    // CapInh may keep bits (inert under no_new_privs), so it is reported, not
    // judged; CapBnd likewise.
    for (const probe of ["cap-prm", "cap-eff", "cap-amb"]) {
      const set = need(`${id}.${probe}`);
      if (!/^0+$/.test(set)) {
        fail(
          `runner ${id} (uid ${uid}) holds capabilities ${probe}=${set} — expected none ` +
            "(the sidecar's ambient set leaked across the wrapper)",
        );
      }
    }
    const noNewPrivs = need(`${id}.no-new-privs`);
    if (noNewPrivs !== "1") {
      fail(`runner ${id} (uid ${uid}) has NoNewPrivs=${noNewPrivs}, expected 1`);
    }
    capReport.push(`${id}=inh:${need(`${id}.cap-inh`)}/bnd:${need(`${id}.cap-bnd`)}`);
    const groups = need(`${id}.groups`);
    const groupSet = new Set(groups === "none" ? [] : groups.split(",").map(Number));
    const allowed = new Set([uid, ...(id === "r2" ? [GUEST_WORKSPACE_GID] : [])]);
    const foreign = [...groupSet].filter((g) => !allowed.has(g));
    if (foreign.length > 0) {
      fail(
        `runner ${id} (uid ${uid}) holds group(s) ${foreign.join(",")} (groups ${groups}) — ` +
          (foreign.includes(GUEST_WORKSPACE_GID)
            ? "the workspace group leaked onto a runner that did not opt into the workspace"
            : "expected only its private group" + (id === "r2" ? " and workspace" : "")),
      );
    }
    if (id === "r2" && !groupSet.has(GUEST_WORKSPACE_GID)) {
      fail(
        `runner r2 opted into the workspace but lacks group ${GUEST_WORKSPACE_GID} (groups ` +
          `${groups}) — the wrapper never got --workspace, and r1/mitm lacking it proves nothing`,
      );
    }
    const expectedHome = `/home/runner${uid - GUEST_RUNNER_UID_FIRST}`;
    const home = need(`${id}.home`);
    if (home !== expectedHome) {
      fail(`runner ${id} (uid ${uid}) has HOME=${home}, expected ${expectedHome}`);
    }
    const homeStat = need(`${id}.home-stat`);
    if (homeStat !== `700:${uid}`) {
      fail(`runner ${id} HOME ${home} is mode:owner ${homeStat}, expected 700:${uid}`);
    }
    const homeReadable = need(`${id}.home-readable`);
    if (homeReadable !== "yes") {
      fail(
        `runner ${id} cannot list its own HOME (${homeReadable}) — the foreign-home check is vacuous`,
      );
    }
    for (const [probe, want] of [
      ["umask", "007"],
      ["umask-file", "660"],
      ["umask-dir", "770"],
    ] as const) {
      const got = need(`${id}.${probe}`);
      if (got !== want) {
        fail(`runner ${id} ${probe} is ${got}, expected ${want} (umask 007: no world bits)`);
      }
    }
    const foreignHomes = need(`${id}.foreign-homes`);
    if (foreignHomes !== `0/${GUEST_RUNNER_UID_COUNT - 1}`) {
      fail(
        `runner ${id} foreign homes readable/existing = ${foreignHomes}, expected ` +
          `0/${GUEST_RUNNER_UID_COUNT - 1} — a sibling's 0700 HOME is readable, or the pool ` +
          "homes are missing",
      );
    }
    const proxyEnv = need(`${id}.proxy-env`);
    const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(proxyEnv)?.[1]);
    if (!Number.isInteger(port) || port <= 0) {
      fail(
        `runner ${id} got HTTPS_PROXY ${proxyEnv}, expected 127.0.0.1:<port> — the sidecar ` +
          "mounted no listener for spec.egress",
      );
    }
    listenerPorts.set(id, port);
  }
  // --- 4a. One uid per runner.
  if (new Set(uids.values()).size !== live.length) {
    fail(`runners share a uid (${[...uids].map(([id, u]) => `${id}=${u}`).join(" ")})`);
  }

  // --- /workspace (2770 agent:workspace): listed by the runner that opted in
  //     (the control), refused to the ones that did not. Without r2 the
  //     refusals would be vacuous, so they are not judged.
  if (has("r2")) {
    const r2Workspace = need("r2.workspace-readdir");
    if (!/^listed:\d+$/.test(r2Workspace)) {
      fail(
        `runner r2 opted into the workspace but could not list /workspace (${r2Workspace}) — ` +
          "the r1/mitm refusals would be vacuous",
      );
    }
    for (const id of live.filter((r) => r !== "r2")) {
      const listing = need(`${id}.workspace-readdir`);
      if (!PERMISSION_DENIED.test(listing)) {
        fail(
          `runner ${id} got ${listing} listing /workspace without opting in, while r2 got ` +
            `${r2Workspace} — the workspace is reachable outside its group`,
        );
      }
    }
  }

  // --- The agent's controls: the stub counter path (next to r1's zero direct
  //     hits) and its forward proxy before AND after (1) the runners'
  //     attribution went live (next to r1's refusal through it).
  const control = need("agent.platform-control");
  if (hits.control === 0 || !isSuccess(control)) {
    fail(
      `the agent's control request never reached the stub counter (${control}` +
        `${diag("agent.platform-control")}, ` +
        `${hits.control} hit(s)) — the zero-direct-hit assertion would be vacuous`,
    );
  }
  const agentProxyControl = need("agent.proxy-control");
  if (!isConnect200(agentProxyControl)) {
    fail(
      `the agent's own CONNECT through its forward proxy got ${agentProxyControl}` +
        `${diag("agent.proxy-control")}, ` +
        "expected 200 — the runner refusal below would be vacuous",
    );
  }
  const agentProxyAfter = need("agent.proxy-after");
  if (!isConnect200(agentProxyAfter)) {
    fail(
      `once the runners existed, the agent's own CONNECT through its forward proxy got ` +
        `${agentProxyAfter}, expected 200 — the swapped-in runner attribution locks the agent out`,
    );
  }

  // --- The guest can do a full TLS exchange at all: example.com through the
  //     forward proxy (public roots, `GET /`) — the work every runner's allowed
  //     fetch does. Without it the allowed-path failures below say nothing
  //     about runner plumbing.
  const tlsControl = need("agent.tls-control");
  if (!isSuccess(tlsControl)) {
    fail(
      `the agent's full TLS fetch of https://example.com through its forward proxy got ` +
        `${tlsControl}${diag("agent.tls-control")} — TLS from this guest is broken or slower ` +
        `than ${FETCH_TIMEOUT_MS / 1000}s, so no runner's allowed path could succeed`,
    );
  }

  // --- Every runner: no direct UDP egress. The host's prerouting counter
  //     (proven live by the host's own datagram) saw no guest datagram to
  //     UDP_PORT, while each runner's same-socket DNS query to the same
  //     address was answered through the per-uid port-53 redirect.
  const udpSends: string[] = [];
  for (const id of live) {
    const dnsControl = need(`${id}.udp-dns-control`);
    if (!dnsControl.startsWith("answered:")) {
      fail(
        `runner ${id}'s UDP DNS query to ${aliasIp}:53 got ${dnsControl} — the redirected-DNS ` +
          "control failed, so its zero direct-UDP count would be vacuous",
      );
    }
    udpSends.push(`${id}=${need(`${id}.udp-platform`)}`);
  }
  if (udpGuest !== 0) {
    fail(
      `the host counted ${udpGuest} guest datagram(s) to UDP port ${UDP_PORT} at prerouting ` +
        `(runner send outcomes: ${udpSends.join(" ")}) — runner uids keep direct UDP egress`,
    );
  }

  // --- r1 — plain CONNECT, allowed https://example.com.
  const r1Allowed = marker(log, "r1.proxy-allowed") ?? "r1-not-spawned";
  const plainAllowed = marker(log, "r1.transparent-allowed") ?? "r1-not-spawned";
  if (has("r1")) {
    // No direct TCP egress: a refused attempt AND zero stub hits, next to the
    // agent's successful control on the same counter.
    const direct = need("r1.direct-platform");
    if (!/^(error:|timeout|closed-before-connect)/.test(direct)) {
      fail(
        `runner's direct TCP to the platform stub was not refused (${direct}) — ` +
          "runner uids keep direct egress",
      );
    }
    if (hits.direct !== 0) {
      fail(
        `platform stub saw ${hits.direct} direct runner hit(s) on ${DIRECT_PATH} — ` +
          "runner uids keep direct egress",
      );
    }
    // Its CONNECT listener enforces authorized_uris.
    if (!isSuccess(r1Allowed)) {
      fail(
        `runner r1 could not reach https://example.com through its CONNECT listener ` +
          `(${r1Allowed}${diag("r1.proxy-allowed")}) — allowlisted egress is broken (the ` +
          "guest's sidecar also needs " +
          "internet access), and every refusal through that listener below would be vacuous",
      );
    }
    const r1Denied = need("r1.proxy-denied");
    if (!isProxy403(r1Denied)) {
      fail(
        `runner r1's fetch of https://example.org through its CONNECT listener got ` +
          `${r1Denied}${diag("r1.proxy-denied")}, expected the listener's policy 403`,
      );
    }
    // The transparent plane for proxy-unaware clients, same policy.
    if (!isSuccess(plainAllowed)) {
      fail(
        `proxy-unaware runner client could not reach https://example.com (${plainAllowed}` +
          `${diag("r1.transparent-allowed")}) — ` +
          "transparent plane (DNS -> 127.0.0.1 -> SNI splicer) is broken",
      );
    }
    const plainDenied = need("r1.transparent-denied");
    if (!isResetRefusal(plainDenied)) {
      fail(
        `proxy-unaware runner client got ${plainDenied}${diag("r1.transparent-denied")} for ` +
          "https://example.org, expected the transparent plane's reset — it ignores the " +
          "allowlist, or the refusal is not the plane's",
      );
    }
    const dns = need("r1.dns");
    if (dns !== "127.0.0.1") {
      fail(
        `runner resolved example.com to ${dns}, expected 127.0.0.1 — ` +
          "runner DNS is not redirected to the sidecar's responder",
      );
    }
    // 3. The transparent plane admits runner r1 and refuses the agent (same TLS
    //    probe, same SNI, two uids).
    const r1Tls = need("r1.transparent-tls");
    if (r1Tls !== "secure") {
      fail(
        `runner r1's TLS handshake to 127.0.0.1:${GUEST_TRANSPARENT_TLS_PORT} (SNI example.com) ` +
          `got ${r1Tls}${diag("r1.transparent-tls")} — the agent refusal below would be vacuous`,
      );
    }
    const agentTls = need("agent.transparent-tls");
    if (!isResetRefusal(agentTls)) {
      fail(
        `the agent's TLS handshake through the transparent plane got ${agentTls}` +
          `${diag("agent.transparent-tls")}, expected the plane's reset — the splicer serves ` +
          "non-runner peers, or the refusal is not the plane's",
      );
    }
    // r1 through the agent's forward proxy: refused (the agent's own 200s above).
    const runnerViaAgentProxy = need("r1.agent-proxy");
    if (!isConnect403(runnerViaAgentProxy)) {
      fail(
        `runner's CONNECT through the agent's forward proxy got ${runnerViaAgentProxy}` +
          `${diag("r1.agent-proxy")}, expected the proxy's 403 refusal`,
      );
    }
    // 2. r1's listener refuses the agent, next to its owner's success.
    const viaR1 = need("agent.via-r1-listener");
    if (!isConnect403(viaR1)) {
      fail(
        `the agent's CONNECT example.com through runner r1's listener got ${viaR1} while r1's ` +
          `own got ${r1Allowed}, expected the listener's 403 — it does not attribute its peers`,
      );
    }
  }

  // --- r2 — plain CONNECT, allowed https://example.org only.
  if (has("r2")) {
    // Its own listener works for ITS target and refuses r1's.
    const r2Allowed = need("r2.proxy-allowed");
    if (!isSuccess(r2Allowed)) {
      fail(
        `runner r2 could not reach https://example.org through its own listener (${r2Allowed}` +
          `${diag("r2.proxy-allowed")}) ` +
          "— its refusals would be vacuous",
      );
    }
    const r2Denied = need("r2.proxy-denied");
    if (!isProxy403(r2Denied)) {
      fail(
        `runner r2's fetch of https://example.com through its own listener got ` +
          `${r2Denied}${diag("r2.proxy-denied")}, expected the listener's policy 403`,
      );
    }
    // The plane serves each runner ITS policy: example.org through the plane
    // (the control) while example.com — r1's target — is refused.
    const r2PlainAllowed = need("r2.transparent-allowed");
    if (!isSuccess(r2PlainAllowed)) {
      fail(
        `runner r2's proxy-unaware client could not reach https://example.org through the ` +
          `transparent plane (${r2PlainAllowed}${diag("r2.transparent-allowed")}) — its ` +
          "refusal below would be vacuous",
      );
    }
    const r2PlainDenied = need("r2.transparent-denied");
    if (!isResetRefusal(r2PlainDenied)) {
      fail(
        `runner r2's proxy-unaware client got ${r2PlainDenied}${diag("r2.transparent-denied")} ` +
          "for https://example.com through the transparent plane, expected the plane's reset — " +
          `it applied another runner's policy (r1 got ${plainAllowed} there), or the refusal ` +
          "is not the plane's",
      );
    }
    // 4b. Cross-runner attribution on the real kernel: r2 through r1's listener
    //     is refused while r1 through it succeeded.
    if (has("r1")) {
      const peerAddress = need("r2.peer-address");
      const r1ProxyEnv = need("r1.proxy-env");
      if (peerAddress !== r1ProxyEnv) {
        fail(`runner r2 dialed ${peerAddress}, not runner r1's listener ${r1ProxyEnv}`);
      }
      const r2ViaR1 = need("r2.peer-listener");
      if (!isConnect403(r2ViaR1)) {
        fail(
          `runner r2 (uid ${uids.get("r2")}) got ${r2ViaR1} for CONNECT example.com through ` +
            `runner r1's listener, while r1 (uid ${uids.get("r1")}) got ${r1Allowed}; ` +
            "expected the listener's 403 — it serves a sibling runner under its owner's policy",
        );
      }
    }
  }

  // --- mitm — delivery.http: MITM listener, run CA.
  if (has("mitm")) {
    // 6a. Credential fetched, CA readable on its uid, TLS terminated by the
    //     listener (the run CA's leaf does not verify on public roots),
    //     allowlist enforced, the agent refused.
    if (hits.credentials === 0) {
      fail(
        "the sidecar never fetched the MITM integration's credentials — delivery.http did not " +
          "reach it, so no MITM listener can have been mounted",
      );
    }
    const caReadable = need("mitm.ca-readable");
    if (!/^bytes:[1-9]\d*$/.test(caReadable)) {
      fail(
        `MITM runner could not read the run CA (${caReadable}) — ` +
          (caReadable === "missing-env"
            ? "no CA env: the sidecar mounted a plain CONNECT listener instead of MITM (run-CA " +
              "mint failed — is openssl in the guest rootfs?)"
            : "the CA dir/file is not readable on the runner's uid"),
      );
    }
    const mitmAllowed = need("mitm.mitm-allowed");
    if (!isSuccess(mitmAllowed)) {
      fail(
        `MITM runner could not fetch https://example.com through its MITM listener ` +
          `(${mitmAllowed}${diag("mitm.mitm-allowed")}) — MITM egress is broken on the ` +
          "runner's uid",
      );
    }
    const mitmUntrusted = need("mitm.mitm-untrusted");
    if (!/^error:.*(CERT|SIGNATURE|ISSUER|SELF_SIGNED|UNTRUSTED)/i.test(mitmUntrusted)) {
      fail(
        `a public-roots-only client through the MITM listener got ${mitmUntrusted}` +
          `${diag("mitm.mitm-untrusted")}, expected ` +
          "a certificate verification error — the listener did not terminate TLS with the run CA",
      );
    }
    // The listener accepts the CONNECT, reads the ClientHello and drops an
    // unauthorized SNI before minting a leaf: Bun's proxied fetch reports that
    // reset as ECONNRESET. Only that — a verification error here could be a
    // leaf the run CA does not sign, i.e. not the listener's refusal.
    const mitmDenied = need("mitm.mitm-denied");
    if (mitmDenied !== "error:ECONNRESET") {
      fail(
        `MITM runner's fetch of https://example.org through its MITM listener got ` +
          `${mitmDenied}${diag("mitm.mitm-denied")}, expected the listener's reset ` +
          "(error:ECONNRESET)",
      );
    }
    const viaMitm = need("agent.via-mitm-listener");
    if (!isConnect403(viaMitm)) {
      fail(
        `the agent's CONNECT example.com through the MITM runner's listener got ${viaMitm}, ` +
          "expected the listener's 403 — it does not attribute its peers",
      );
    }
    // 6b. The transparent plane refuses a MITM-delivery runner (splicing would
    //     bypass credential injection): its DNS lands on the plane (routing
    //     control), yet example.com — reached through its own listener — is
    //     refused there.
    const mitmDns = need("mitm.dns");
    if (mitmDns !== "127.0.0.1") {
      fail(
        `the MITM runner resolved example.com to ${mitmDns}, expected 127.0.0.1 — its ` +
          "transparent-plane refusal below would not prove the plane refused it",
      );
    }
    const mitmPlain = need("mitm.transparent-denied");
    if (!isResetRefusal(mitmPlain)) {
      fail(
        `the MITM runner's proxy-unaware client got ${mitmPlain}` +
          `${diag("mitm.transparent-denied")} for https://example.com through the transparent ` +
          `plane (r1 got ${plainAllowed}, its own listener ${mitmAllowed}), expected the ` +
          "plane's reset — it splices a MITM-delivery runner past credential injection, or " +
          "the refusal is not the plane's",
      );
    }
    // 6c. The inner TLS servers' unix sockets sit in a 0700 sidecar dir under
    //     /tmp. The dir exists (control) and an inner server lives in it
    //     (mitm-allowed succeeded through one), yet the agent cannot list it —
    //     and without search permission on it, no name inside resolves, so no
    //     socket there is reachable.
    const dirStat = need("agent.mitm-dir-stat");
    const statEntries = dirStat.split(",");
    if (dirStat === "none" || statEntries.some((e) => e !== `700:${GUEST_SIDECAR_UID}`)) {
      fail(
        `the MITM socket dir(s) under /tmp read as ${dirStat}, expected ` +
          `700:${GUEST_SIDECAR_UID} each — the dir is missing (the refusal below would be ` +
          "vacuous) or not sidecar-private",
      );
    }
    const dirReaddir = need("agent.mitm-dir-readdir");
    const listings = dirReaddir.split(",");
    if (
      listings.length !== statEntries.length ||
      !listings.every((r) => PERMISSION_DENIED.test(r))
    ) {
      fail(
        `the agent's readdir of the MITM socket dir(s) got ${dirReaddir}, expected EACCES for ` +
          "each — the MITM listener's inner servers are reachable outside the sidecar",
      );
    }
  }

  // --- 6d. The sidecar's LISTEN sockets are exactly the known listeners (the
  //         spawned runners' included): an extra one is a reachable inner
  //         server (e.g. a MITM per-SNI TLS server on TCP, or a failed
  //         runner's listener left behind); a missing one means the scan is
  //         broken.
  const listen = need("agent.listen");
  const entries = listen.split(",");
  if (entries.includes("unreadable-tcp") || listen === "none") {
    fail(`the agent could not scan /proc/net/tcp (${listen})`);
  }
  const sidecarPorts = new Set<number>();
  for (const entry of entries) {
    if (entry === "unreadable-tcp6") continue; // guest kernel without IPv6
    const m = /^(\d+)\/(.+):(\d+)$/.exec(entry);
    if (!m) fail(`unparseable LISTEN entry '${entry}' in ${listen}`);
    if (m[1] === GUEST_SIDECAR_UID) sidecarPorts.add(Number(m[3]));
  }
  const expectedListeners = new Map<number, string>([
    [GUEST_SIDECAR_PORT, "sidecar"],
    [GUEST_FORWARD_PROXY_PORT, "agent forward proxy"],
    [GUEST_TRANSPARENT_TLS_PORT, "transparent TLS splicer"],
    [GUEST_TRANSPARENT_HTTP_PORT, "transparent HTTP splicer"],
    ...[...listenerPorts].map(([id, port]) => [port, `${id} listener`] as [number, string]),
  ]);
  const extra = [...sidecarPorts].filter((p) => !expectedListeners.has(p));
  if (extra.length > 0) {
    fail(
      `the sidecar (uid ${GUEST_SIDECAR_UID}) listens on unexpected TCP port(s) ` +
        `${extra.join(",")} — an inner server is reachable over TCP (LISTEN table: ${listen})`,
    );
  }
  const missing = [...expectedListeners].filter(([p]) => !sidecarPorts.has(p));
  if (missing.length > 0) {
    fail(
      `the LISTEN scan misses ${missing.map(([p, what]) => `${p} (${what})`).join(", ")} — ` +
        `the scan (or the uid ${GUEST_SIDECAR_UID} filter) is broken (LISTEN table: ${listen})`,
    );
  }

  // --- Last: the runners that never spawned, with the sidecar's reason.
  //     Everything above passed for the ones that did.
  if (bootFailures.length > 0) {
    fail(
      `every result from the spawned runners (${live.join(",") || "none"}) and the agent ` +
        `passed, but not every probe runner spawned — ${bootFailures.join("; ")}`,
    );
  }

  console.log(
    `    runner egress ok (sidecar ready after ${ready} ms): 3 runners on distinct pool uids ` +
      "with private groups/HOME/umask, no permitted/effective/ambient capability and " +
      `no_new_privs (${capReport.join(" ")}), /workspace only when opted in, no direct TCP ` +
      `or UDP egress (UDP sends: ${udpSends.join(" ")}; 0 guest datagrams at prerouting), ` +
      "per-runner allowlists via CONNECT + MITM + transparent plane (plane refuses the MITM " +
      "runner), listeners (403) and splicer (reset) refuse the agent and siblings, agent " +
      "keeps its forward proxy, MITM socket dir private, no inner server on TCP",
  );
}

/** Boot the fourth VM, take every verdict, tear it down. */
async function runRunnerEgressVm(
  ctx: RunnerEgressContext,
  deps: RunnerEgressVmRunDeps,
): Promise<void> {
  const fail: Fail = ctx.fail;
  const { hits } = ctx;
  const { orch, runId, dumpConsole, withExitTimeout } = deps;
  Reflect.set(orch, "agentArgvOverride", ["bun", "-e", ctx.agentJs]);
  const boundary = await orch.createIsolationBoundary(runId);
  let udp: UdpCounter | undefined;
  try {
    udp = await openUdpCounter(ctx.aliasIp, fail);
    const sidecar = await orch.createSidecar(runId, boundary, {
      runToken: deps.runToken,
      sidecarAuthToken: SIDECAR_AUTH_TOKEN,
      integrations: ctx.integrations,
    });
    // The probes dial the sidecar's ports by number (a runner cannot read the
    // sidecar's env) and the listener-set assertion expects them — pin both to
    // the env the sidecar will boot on. r2's workspace opt-in (the positive
    // `workspace` control) needs the directory handle the adapter reads.
    const pending = Reflect.get(orch, "pendingSidecarEnv") as Map<string, Record<string, string>>;
    const env = pending.get(runId) ?? {};
    for (const [key, want] of [
      ["PORT", GUEST_SIDECAR_PORT],
      ["FORWARD_PROXY_PORT", GUEST_FORWARD_PROXY_PORT],
    ] as const) {
      if (env[key] !== String(want)) {
        fail(`sidecar ${key} is ${env[key]}, the #1547 probes expect ${want} — update the smoke`);
      }
    }
    // The agent reads the boot report with this bearer: the sidecar must boot on it.
    if (env.SIDECAR_AUTH_TOKEN !== SIDECAR_AUTH_TOKEN) {
      fail(
        "the sidecar env does not carry the smoke's SIDECAR_AUTH_TOKEN — the agent's " +
          "boot-report read (the runners' start gate) would be refused",
      );
    }
    if (!/"kind":"directory"/.test(env.WORKSPACE_HANDLE_JSON ?? "")) {
      fail(
        `sidecar WORKSPACE_HANDLE_JSON is ${env.WORKSPACE_HANDLE_JSON} — r2's workspace ` +
          "opt-in (the workspace control) needs a directory handle",
      );
    }
    const agent = await orch.createWorkload(
      {
        runId,
        role: "agent",
        image: "unused-by-firecracker",
        env: ctx.agentEnv,
        resources: { memoryBytes: 512 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary,
    );
    await orch.startWorkload(agent);
    const exitCode = await withExitTimeout(
      orch.waitForExit(agent),
      `fourth VM did not exit within ${VM_TIMEOUT_MS / 1000}s`,
      VM_TIMEOUT_MS,
    );
    console.log(`==> fourth guest exit marker: ${exitCode}`);
    const udpGuest = await udp.readGuest();
    const consoleLog = await Bun.file(`${boundary.id}/console.log`)
      .text()
      .catch(() => "");
    await dumpConsole(boundary.id, "vm4");
    // The tail above is dominated by sidecar logs: surface every probe marker
    // and runner/egress line wherever it sits in the console.
    console.log("---- #1547 probe + runner lines (vm4) ----");
    for (const line of consoleLog.split("\n")) {
      if (
        line.includes(TAG) ||
        line.includes("runner-egress-diag") ||
        line.includes("integration stderr") ||
        line.includes("egress") ||
        line.includes("mitm") ||
        line.includes("MITM") ||
        line.includes("Integration") ||
        line.includes("integration runtime") ||
        line.includes("boot wait")
      ) {
        console.log(line);
      }
    }
    console.log(
      `     stub hits: bundle=${hits.bundle} direct=${hits.direct} control=${hits.control} ` +
        `credentials=${hits.credentials} udp-guest-at-prerouting=${udpGuest}`,
    );
    console.log("------------------------------");
    if (exitCode !== 0) {
      fail(`expected exit marker 0 from the fourth VM, got ${exitCode} (agent probe failed)`);
    }
    assertRunnerEgress(consoleLog, ctx, udpGuest);
    await orch.removeWorkload(sidecar);
    await orch.removeWorkload(agent);
  } catch (err) {
    await dumpConsole(boundary.id, "vm4 exception");
    throw err;
  } finally {
    await udp?.close();
    await orch.removeIsolationBoundary(boundary).catch(() => {});
  }
}

/**
 * Build the fourth VM. The probe programs are bundled here, so a bundling
 * error fails the smoke before any VM boots.
 */
export async function createRunnerEgressVm(
  options: RunnerEgressVmOptions,
): Promise<RunnerEgressVm> {
  const { aliasIp, platformPort, fail } = options;
  const [runnerJs, agentJs] = await Promise.all([
    bundleProbe("runner.js", fail),
    bundleProbe("agent.js", fail),
  ]);
  const probeBundle = zipSync({ "server.js": new TextEncoder().encode(runnerJs) });
  const hits: StubHits = {
    bundle: 0,
    direct: 0,
    control: 0,
    credentials: 0,
  };
  const ctx: RunnerEgressContext = {
    aliasIp,
    fail,
    hits,
    integrations: probeIntegrations(aliasIp, platformPort),
    agentJs,
    agentEnv: {
      PROBE_TAG: TAG,
      PROBE_EXPECTED: IDS.join(","),
      PROBE_DONE_PORT: String(DONE_PORT),
      PROBE_FETCH_TIMEOUT_MS: String(FETCH_TIMEOUT_MS),
      PROBE_SIDECAR_PORT: String(GUEST_SIDECAR_PORT),
      PROBE_FORWARD_PROXY_PORT: String(GUEST_FORWARD_PROXY_PORT),
      PROBE_TRANSPARENT_TLS_PORT: String(GUEST_TRANSPARENT_TLS_PORT),
      PROBE_CONTROL_URL: `http://${aliasIp}:${platformPort}${CONTROL_PATH}`,
      PROBE_SIDECAR_READY_WAIT_MS: String(SIDECAR_READY_WAIT_MS),
      PROBE_RUNNERS_WAIT_MS: String(RUNNERS_WAIT_MS),
      PROBE_BOOT_REPORT_WAIT_MS: String(BOOT_REPORT_WAIT_MS),
      PROBE_RUNNER_INTEGRATIONS: IDS.map((id) => `${id}=${INTEGRATION_OF[id]}`).join(","),
      PROBE_SIDECAR_AUTH_HEADER: SIDECAR_AUTH_HEADER,
      SIDECAR_AUTH_TOKEN,
    },
  };

  return {
    handleStubRequest(req: Request): Response | undefined {
      const { pathname } = new URL(req.url);
      if (pathname === BUNDLE_PATH) {
        hits.bundle++;
        return new Response(probeBundle, { headers: { "content-type": "application/zip" } });
      }
      if (pathname === CREDENTIALS_PATH && req.method === "GET") {
        hits.credentials++;
        return Response.json(MITM_CREDENTIALS);
      }
      if (pathname === DIRECT_PATH) hits.direct++;
      else if (pathname === CONTROL_PATH) hits.control++;
      else return undefined;
      return new Response("ok");
    },
    run: (deps) => runRunnerEgressVm(ctx, deps),
  };
}
