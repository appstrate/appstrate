// SPDX-License-Identifier: Apache-2.0
/* global Bun */

/**
 * #1547 probe runner — the `server.js` of the probe mcp-server bundle the
 * smoke's platform stub serves. The in-guest sidecar runs it as an integration
 * runner in one of three roles (`PROBE_ROLE`):
 *
 *   connect  (r1)   plain-CONNECT listener, allowed https://example.com
 *   cross    (r2)   plain-CONNECT listener, allowed https://example.org only,
 *                   opted into the workspace
 *   mitm     (mitm) `delivery.http` (MITM) listener, allowed https://example.com/**
 *
 * It is a minimal MCP stdio server — just enough for the sidecar's initialize +
 * tools/list handshake, so the runner stays alive for the whole run instead of
 * being reaped by a failed connect. Its probes start only once it has answered
 * `tools/list` AND the agent reports the sidecar's integration boot finished
 * (the start gate below), so no probe competes with a runner's connect budget.
 * Every role runs the identity and UDP probes and adds its own. Targets arrive
 * through `spawnEnv` (PROBE_*), the listener through the adapter's HTTPS_PROXY.
 *
 * Observations are raw (`200`, `error:EACCES`, ...): the verdict is taken
 * host-side (`../smoke-runner-egress.ts`). A denial is only meaningful next to
 * its allowed twin (same route with an allowed target, or the same target from
 * its owner) — an error alone could be a broken route rather than a refusal.
 *
 * Transport: the runner never relies on its stderr (runner stderr → sidecar
 * log → serial console lost lines under nested virt, and the sidecar dies at
 * poweroff). It delivers its lines to the agent over the loopback report
 * channel and waits for the ack; the agent prints them. The stderr copy carries
 * another prefix (`runner-egress-diag`), so the host never reads it by mistake.
 *
 * Channel protocol (one request per connection, newline-separated):
 *   - marker lines, then `END` → the agent validates each line, prints it
 *     once (a re-sent report adds nothing), and acks `ok` on `END`. The `<id>.done=1` line (sent only once every probe, child
 *     processes included, has settled) marks this runner finished.
 *   - `GET <id>.<probe>` → the agent answers the value it holds, or `unknown`
 *     (r2 learns r1's listener address this way). `GET agent.go` answers `1`
 *     once the sidecar's integration boot report is in (the start gate).
 */

import * as dgram from "node:dgram";
import { promises as dnsPromises } from "node:dns";
import * as fs from "node:fs";

import {
  CONNECT_EXAMPLE_COM,
  clean,
  deliver,
  errorDetail,
  errorOf,
  exchange,
  failure,
  fetchStatus,
  hostPort,
  numberSetting,
  octal,
  setting,
  sleep,
  timed,
  tlsHandshake,
  valueOf,
} from "./helpers.js";

const env = process.env;
const TAG = setting("PROBE_TAG");
const ID = setting("PROBE_RUNNER_ID");
const ROLE = setting("PROBE_ROLE");
const DONE_PORT = numberSetting("PROBE_DONE_PORT");
const PEER_WAIT_MS = numberSetting("PROBE_PEER_WAIT_MS");
const CHILD_TIMEOUT_MS = numberSetting("PROBE_CHILD_TIMEOUT_MS");
const FETCH_TIMEOUT_MS = numberSetting("PROBE_FETCH_TIMEOUT_MS");
const PLATFORM_HOST = setting("PROBE_PLATFORM_HOST");
const UDP_PORT = numberSetting("PROBE_UDP_PORT");
const TRANSPARENT_TLS_PORT = numberSetting("PROBE_TRANSPARENT_TLS_PORT");
const HANDSHAKE_WAIT_MS = numberSetting("PROBE_HANDSHAKE_WAIT_MS");
/** The shared workspace (guest init.sh: 2770, agent:workspace). */
const WORKSPACE_DIR = "/workspace";
/**
 * `/proc/self/status` fields reported verbatim (capability sets in hex, the
 * no_new_privs flag), as `<probe>=<value>`. The sidecar holds ambient
 * CAP_NET_BIND_SERVICE + CAP_KILL; the host requires a runner to hold none.
 */
const STATUS_FIELDS = [
  ["CapInh", "cap-inh"],
  ["CapPrm", "cap-prm"],
  ["CapEff", "cap-eff"],
  ["CapAmb", "cap-amb"],
  ["CapBnd", "cap-bnd"],
  ["NoNewPrivs", "no-new-privs"],
];

const lines = [];
const line = (probe, value) => TAG + " " + ID + "." + probe + "=" + clean(value);

function mark(probe, value, max) {
  const text = TAG + " " + ID + "." + probe + "=" + clean(value, max);
  lines.push(text);
  // Diagnostic copy only — deliberately NOT prefixed with TAG.
  console.error("runner-egress-diag " + text.slice(TAG.length + 1));
}

/**
 * Run one probe and mark its verdict value; an observation carrying extra
 * fields (`detail`, `ms`, `lookup`, …) marks each as `<name>-<field>` too —
 * diagnostics only, the host judges the value.
 */
async function probe(name, run) {
  try {
    const observation = await run();
    mark(name, valueOf(observation));
    if (observation && typeof observation === "object") {
      for (const [field, extra] of Object.entries(observation)) {
        if (field !== "value" && extra !== undefined && extra !== "") {
          mark(name + "-" + field, extra, 400);
        }
      }
    }
  } catch (err) {
    mark(name, "crash:" + errorOf(err));
    mark(name + "-detail", errorDetail(err), 400);
  }
}

/** A network probe: {@link probe} with its elapsed time as `<name>-ms`. */
function netProbe(name, run) {
  return probe(name, () => timed(run));
}

/** A raw exchange's verdict: `connected:<status line>` or its error, with the error's detail. */
function exchangeObservation(r) {
  return { value: r.connected ? "connected:" + r.line : r.error, detail: r.detail };
}

/** A synchronous attempt as an observation: its result, or `error:<code>`. */
function attempt(run) {
  try {
    return run();
  } catch (err) {
    return errorOf(err);
  }
}

// ---- MCP stdio (newline-delimited JSON-RPC) ----

// The sidecar gives a runner a fixed 30 s to connect (initialize, then the
// `tools/list` McpHost.register sends). Under nested virt a runner busy with
// its own probes (child `bun` processes on 2 vCPUs) missed it, and the sidecar
// tore its listener down. So NO probe starts before this runner has answered
// `tools/list`: the 30 s pay for the cold start alone. The fallback only
// bounds a sidecar that never asks; the host asserts `handshake=tools-list`.
let finishHandshake;
const handshake = new Promise((resolve) => {
  finishHandshake = resolve;
});
const handshakeTimer = setTimeout(() => finishHandshake("timeout"), HANDSHAKE_WAIT_MS);

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

function handleRequest(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "runner-egress-probe", version: "1.0.0" },
    });
  } else if (msg.method === "tools/list") {
    reply(msg.id, {
      tools: [
        {
          name: "noop",
          description: "Does nothing.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    clearTimeout(handshakeTimer);
    finishHandshake("tools-list");
  } else if (msg.method === "tools/call") {
    reply(msg.id, { content: [{ type: "text", text: "ok" }] });
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const raw = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    // Requests only: notifications carry no id, responses no method.
    if (!msg || typeof msg.method !== "string" || msg.id === undefined || msg.id === null) {
      continue;
    }
    handleRequest(msg);
  }
});

// ---- agent channel ----

async function deliverToAgent(text) {
  const deadline = Date.now() + PEER_WAIT_MS;
  let last = "never-tried";
  while (Date.now() < deadline) {
    last = await deliver("127.0.0.1", DONE_PORT, text, 5000);
    if (last === "acked") return last;
    await sleep(1000);
  }
  return last;
}

async function askAgent(key) {
  const deadline = Date.now() + PEER_WAIT_MS;
  while (Date.now() < deadline) {
    const r = await exchange("127.0.0.1", DONE_PORT, "GET " + key + "\r\n", 5000);
    if (r.line && r.line !== "unknown") return r.line;
    await sleep(1000);
  }
  return undefined;
}

// ---- probe primitives ----

function viaProxy(proxy, url, init) {
  if (!proxy) return "no-proxy-env";
  return fetchStatus(url, Object.assign({ proxy }, init || {}), FETCH_TIMEOUT_MS);
}

// A child whose env carries ONLY PATH/HOME/PROBE_*: no proxy variable (unless
// one is passed explicitly) and no CA variable. Without a proxy its only way
// out is the transparent plane (DNS -> 127.0.0.1 -> SNI splicer); with one it
// trusts nothing but the public roots.
//
// This function is the child's whole program: it is serialised with
// `toString()` into `bun -e`, so it references globals only (no import, no
// closure). It prints ONE JSON line: the verdict `value`, the error `detail`
// (same fields as helpers.js `errorDetail`), where its own resolver sends
// example.com (`lookup`) and the fetch's own time (`fetchms`, cold start
// excluded).
async function childMain() {
  const env = process.env;
  const out = { value: "error:no-result", detail: "", lookup: "", fetchms: 0 };
  const describe = (e) =>
    ["code", "name", "message", "syscall", "address", "port", "errno"]
      .filter((k) => e && e[k] !== undefined && e[k] !== "")
      .map((k) => k + ":" + String(e[k]))
      .join("/");
  const verdict = (e) => {
    const code = e && e.code;
    if (typeof code === "string" && code !== "") return "error:" + code;
    return "error:" + ((e && e.name) || (code !== undefined ? String(code) : "unknown"));
  };
  try {
    const dns = await import("node:dns");
    const found = await dns.promises.lookup("example.com", { all: true });
    out.lookup = found.map((a) => a.address).join(",") || "empty";
  } catch (err) {
    out.lookup = verdict(err) + "/" + describe(err);
  }
  const start = Date.now();
  try {
    const init = { redirect: "manual", signal: AbortSignal.timeout(Number(env.PROBE_TIMEOUT_MS)) };
    if (env.PROBE_PROXY) init.proxy = env.PROBE_PROXY;
    const res = await fetch(env.PROBE_URL, init);
    await res.arrayBuffer().catch(() => {});
    out.value = String(res.status);
  } catch (err) {
    out.value = verdict(err);
    out.detail = describe(err);
    if (err && typeof err.cause === "object" && err.cause) {
      out.detail += "/cause/" + describe(err.cause);
    }
  }
  out.fetchms = Date.now() - start;
  console.log(JSON.stringify(out));
  setTimeout(() => process.exit(0), 50);
}

const CHILD_PROGRAM = "(" + childMain.toString() + ")()";

// Child probes run ONE AT A TIME: each is a cold `bun` start, and several at
// once starve a 2-vCPU guest under nested virt. Each is still bounded by
// CHILD_TIMEOUT_MS, so a runner's children cost at most 2 × CHILD_TIMEOUT_MS.
let childQueue = Promise.resolve();

function childFetch(url, proxy) {
  const run = childQueue.then(() => spawnChildFetch(url, proxy));
  childQueue = run.catch(() => {});
  return run;
}

async function spawnChildFetch(url, proxy) {
  const childEnv = {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: env.HOME || "/tmp",
    PROBE_URL: url,
    PROBE_TIMEOUT_MS: String(FETCH_TIMEOUT_MS),
  };
  if (proxy) childEnv.PROBE_PROXY = proxy;
  const child = Bun.spawn(["bun", "-e", CHILD_PROGRAM], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS);
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  clearTimeout(killer);
  const last = out.trim().split("\n").pop() || "";
  try {
    return JSON.parse(last);
  } catch {
    // No JSON line: the child died (or was killed at CHILD_TIMEOUT_MS) first.
    return { value: "error:no-output", detail: "exit:" + code + "/stderr:" + err.slice(-300) };
  }
}

/**
 * One datagram from a fresh udp4 socket. Settles on the first `onMessage`
 * verdict (a reply), the send's error, or — without `onMessage` — the send's
 * own completion; otherwise on the timeout.
 */
function udpExchange(host, port, payload, timeoutMs, onMessage) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket("udp4");
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed by the error that settled it.
      }
      resolve(result);
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.on("error", (err) => settle(failure(err)));
    if (onMessage) {
      socket.on("message", (msg) => {
        const verdict = onMessage(msg);
        if (verdict !== undefined) settle(verdict);
      });
    }
    socket.send(payload, port, host, (err, bytes) => {
      if (err) settle(failure(err));
      else if (!onMessage) settle("sent:" + bytes);
    });
  });
}

/** A minimal DNS A query for `name` to host:53; settles on the reply that matches it. */
function dnsQuery(host, name, timeoutMs) {
  const id = Math.floor(Math.random() * 0x10000);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // flags: recursion desired
  header.writeUInt16BE(1, 4); // QDCOUNT
  const parts = [header];
  for (const label of name.split(".")) {
    parts.push(Buffer.from([label.length]), Buffer.from(label, "latin1"));
  }
  parts.push(Buffer.from([0, 0, 1, 0, 1])); // root label, QTYPE A, QCLASS IN
  return udpExchange(host, 53, Buffer.concat(parts), timeoutMs, (msg) => {
    // A reply to THIS query: same id, QR bit set.
    if (msg.length < 12 || msg.readUInt16BE(0) !== id || (msg[2] & 0x80) === 0) return undefined;
    return "answered:rcode" + (msg[3] & 0x0f) + ":an" + msg.readUInt16BE(6);
  });
}

async function resolveExampleCom() {
  const found = await dnsPromises.lookup("example.com", { all: true, family: 4 });
  return found.map((a) => a.address).join(",") || "empty";
}

// ---- probes ----

// Every role: who am I, which capabilities do I hold, what is my HOME, what
// does my umask produce, can I read my siblings' homes, and can I list the
// shared workspace.
async function identityProbes() {
  const uid = process.getuid();
  mark("uid", uid);
  mark("gid", process.getgid());
  mark("egid", process.getegid());
  let status = "";
  let statusError = "";
  try {
    status = fs.readFileSync("/proc/self/status", "utf8");
  } catch (err) {
    statusError = errorOf(err);
  }
  for (const [field, name] of STATUS_FIELDS) {
    const found = new RegExp("^" + field + ":\\s*(\\S+)\\s*$", "m").exec(status);
    mark(name, statusError || (found ? found[1] : "missing"));
  }
  await probe("groups", () => {
    const groups = Array.from(new Set(process.getgroups())).sort((a, b) => a - b);
    return groups.length > 0 ? groups.join(",") : "none";
  });
  const home = env.HOME || "";
  mark("home", home || "unset");
  await probe("home-stat", () => {
    const st = fs.statSync(home);
    return octal(st.mode) + ":" + st.uid;
  });
  await probe("home-readable", () => {
    fs.readdirSync(home);
    return "yes";
  });
  await probe("umask", () => octal(process.umask()));
  await probe("umask-file", () => {
    const path = home + "/.smoke-umask-file";
    fs.rmSync(path, { force: true });
    fs.writeFileSync(path, "x", { mode: 0o666 });
    const mode = octal(fs.statSync(path).mode);
    fs.rmSync(path, { force: true });
    return mode;
  });
  await probe("umask-dir", () => {
    const path = home + "/.smoke-umask-dir";
    fs.rmSync(path, { recursive: true, force: true });
    fs.mkdirSync(path, { mode: 0o777 });
    const mode = octal(fs.statSync(path).mode);
    fs.rmSync(path, { recursive: true, force: true });
    return mode;
  });
  await probe("foreign-homes", () => {
    const first = numberSetting("PROBE_UID_FIRST");
    const count = numberSetting("PROBE_UID_COUNT");
    let existing = 0;
    let readable = 0;
    for (let i = 0; i < count; i++) {
      if (first + i === uid) continue;
      const dir = "/home/runner" + i;
      if (!fs.existsSync(dir)) continue;
      existing++;
      if (Array.isArray(attempt(() => fs.readdirSync(dir)))) readable++;
    }
    return readable + "/" + existing;
  });
  // Only a runner that opted into the workspace holds its group (r2): the others
  // must be refused by the directory's missing "other" bits.
  mark(
    "workspace-readdir",
    attempt(() => "listed:" + fs.readdirSync(WORKSPACE_DIR).length),
  );
}

// Every role: a datagram straight at the platform alias on a non-DNS port —
// the guest firewall must drop it (the host counts guest datagrams to that port
// at prerouting on the TAPs) — next to the same socket API reaching the
// sidecar's DNS responder through the per-uid port-53 redirect: the control
// that this uid's datagrams do leave the process.
function udpProbes() {
  return Promise.all([
    netProbe("udp-platform", () =>
      udpExchange(PLATFORM_HOST, UDP_PORT, Buffer.from("runner-egress-1547 " + ID), 5000),
    ),
    netProbe("udp-dns-control", () => dnsQuery(PLATFORM_HOST, "example.com", FETCH_TIMEOUT_MS)),
  ]);
}

// r1 — plain CONNECT, allowed https://example.com.
function connectRoleProbes(proxy) {
  return Promise.all([
    netProbe("direct-platform", async () => {
      const path = setting("PROBE_DIRECT_PATH");
      const request = `GET ${path} HTTP/1.1\r\nHost: platform\r\nConnection: close\r\n\r\n`;
      const port = numberSetting("PROBE_PLATFORM_PORT");
      const r = await exchange(PLATFORM_HOST, port, request, 5000);
      return exchangeObservation(r);
    }),
    netProbe("proxy-allowed", () => viaProxy(proxy, "https://example.com/")),
    netProbe("proxy-denied", () => viaProxy(proxy, "https://example.org/")),
    netProbe("transparent-allowed", () => childFetch("https://example.com/")),
    netProbe("transparent-denied", () => childFetch("https://example.org/")),
    netProbe("transparent-tls", () =>
      tlsHandshake("127.0.0.1", TRANSPARENT_TLS_PORT, "example.com", FETCH_TIMEOUT_MS),
    ),
    netProbe("dns", resolveExampleCom),
    netProbe("agent-proxy", async () => {
      const port = numberSetting("PROBE_AGENT_PROXY_PORT");
      const r = await exchange("127.0.0.1", port, CONNECT_EXAMPLE_COM, 8000);
      return { value: r.line || r.error, detail: r.detail };
    }),
  ]);
}

// r2 — plain CONNECT, allowed https://example.org only: its own listener and the
// transparent plane both serve ITS policy, and r1's listener refuses it.
function crossRoleProbes(proxy) {
  mark("workspace-env", env.APPSTRATE_WORKSPACE || "unset");
  return Promise.all([
    netProbe("proxy-allowed", () => viaProxy(proxy, "https://example.org/")),
    netProbe("proxy-denied", () => viaProxy(proxy, "https://example.com/")),
    netProbe("transparent-allowed", () => childFetch("https://example.org/")),
    netProbe("transparent-denied", () => childFetch("https://example.com/")),
    netProbe("peer-listener", async () => {
      const peer = await askAgent(setting("PROBE_PEER_ID") + ".proxy-env");
      mark("peer-address", peer || "unknown");
      const target = peer ? hostPort(peer) : null;
      if (!target) return "no-peer-address";
      const r = await exchange(target.host, target.port, CONNECT_EXAMPLE_COM, 8000);
      return { value: r.line || r.error, detail: r.detail };
    }),
  ]);
}

// mitm — delivery.http: MITM listener, run CA handed over by the adapter. The
// transparent plane must refuse it (splicing would bypass credential injection).
async function mitmRoleProbes(proxy) {
  const caPath = env.NODE_EXTRA_CA_CERTS || "";
  let caPem = null;
  await probe("ca-readable", () => {
    if (!caPath) return "missing-env";
    caPem = fs.readFileSync(caPath, "utf8");
    return "bytes:" + caPem.length;
  });
  const trustRunCa = caPem ? { tls: { ca: caPem } } : {};
  await Promise.all([
    netProbe("mitm-allowed", () => viaProxy(proxy, "https://example.com/", trustRunCa)),
    netProbe("mitm-denied", () => viaProxy(proxy, "https://example.org/", trustRunCa)),
    // Same listener, public roots only: a TLS-terminating listener presents a
    // leaf signed by the run CA, which must NOT verify — a blind tunnel would.
    netProbe("mitm-untrusted", () =>
      proxy ? childFetch("https://example.com/", proxy) : "no-proxy-env",
    ),
    // Routing control for the refusal below: this uid's DNS lands on the plane.
    netProbe("dns", resolveExampleCom),
    netProbe("transparent-denied", () => childFetch("https://example.com/")),
  ]);
}

function roleProbes(proxy) {
  if (ROLE === "connect") return connectRoleProbes(proxy);
  if (ROLE === "cross") return crossRoleProbes(proxy);
  if (ROLE === "mitm") return mitmRoleProbes(proxy);
  mark("role", "unknown:" + ROLE);
  return Promise.resolve();
}

async function main() {
  const proxy = env.HTTPS_PROXY || "";
  const proxyHostPort = proxy ? proxy.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "") : "missing";
  mark("proxy-env", proxyHostPort);
  // Early hello: a peer (and the agent's listener probes) needs this listener's
  // address before this runner's probes finish.
  const helloText = line("proxy-env", proxyHostPort) + "\n" + line("hello", "1") + "\n";
  const hello = deliverToAgent(helloText);
  mark("handshake", await handshake);
  // Start gate: the sidecar boots runners one after another, so this runner's
  // probes would compete for CPU with a sibling's cold start (and its 30 s
  // connect budget). Start only once the agent reports the sidecar's whole
  // integration boot FINISHED — every spawn done or failed, so a failed sibling
  // cannot hold the gate shut (or the peer wait runs out). `ready` is
  // diagnostic only.
  await deliverToAgent(line("ready", "1") + "\n");
  mark("start-gate", (await askAgent("agent.go")) === "1" ? "open" : "timeout");
  await Promise.all([identityProbes(), udpProbes(), roleProbes(proxy), hello]);
  // Every probe has settled (child processes included): report, then done.
  mark("done", "1");
  const delivered = await deliverToAgent(lines.join("\n") + "\n");
  console.error("runner-egress-diag " + ID + ".delivery=" + delivered);
}

main().catch((err) => console.error("runner-egress-diag " + ID + ".main=crash:" + errorOf(err)));
