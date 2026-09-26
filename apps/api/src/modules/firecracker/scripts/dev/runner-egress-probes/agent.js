// SPDX-License-Identifier: Apache-2.0

/**
 * #1547 agent-side probe program — the fourth smoke VM's agent argv
 * (`bun -e <this file bundled with helpers.js>`, uid 1001). In order:
 *
 *   1. open the runners' report channel (127.0.0.1:PROBE_DONE_PORT): runners
 *      report as soon as they start;
 *   2. wait for the sidecar to be READY — `/health` 200 (it answers 200 once
 *      the forward proxy is up) AND the forward proxy accepting connections —
 *      within its own bound. Under nested virtualization the sidecar's first
 *      log line has been observed ~230 s after the agent started, so nothing
 *      below runs before this; `sidecar-ready` reports the wait or `timeout:…`;
 *   3. the controls that make the runners' refusals discriminating: the stub's
 *      counter path, and a 200 from the forward proxy for the very CONNECT r1
 *      must be refused — while, concurrently, it waits for the sidecar's
 *      integration boot to finish (`boot-report`, `boot-error-<id>`), which
 *      opens the runners' start gate (`GET agent.go`);
 *   4. wait for the final report of every runner the boot report lists as
 *      SPAWNED (a failed spawn never reports) within ITS bound, measured from
 *      here, printing each validated runner line: the serial console is the
 *      host's evidence and the agent is its only direct writer;
 *   5. probe as the agent: its forward proxy once runner attribution is live,
 *      the runners' listeners, the transparent plane, the MITM listener's inner
 *      socket directory, and the kernel's LISTEN socket table.
 *
 * Observations are raw; every verdict is taken host-side
 * (`../smoke-runner-egress.ts`).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as net from "node:net";
import { join } from "node:path";

import {
  CONNECT_EXAMPLE_COM,
  REPORT_END,
  clean,
  errorOf,
  exchange,
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

const TAG = setting("PROBE_TAG");
const EXPECTED = setting("PROBE_EXPECTED").split(",");
const DONE_PORT = numberSetting("PROBE_DONE_PORT");
const FETCH_TIMEOUT_MS = numberSetting("PROBE_FETCH_TIMEOUT_MS");
const SIDECAR_PORT = numberSetting("PROBE_SIDECAR_PORT");
const FORWARD_PROXY_PORT = numberSetting("PROBE_FORWARD_PROXY_PORT");
const TRANSPARENT_TLS_PORT = numberSetting("PROBE_TRANSPARENT_TLS_PORT");
const CONTROL_URL = setting("PROBE_CONTROL_URL");
const SIDECAR_READY_WAIT_MS = numberSetting("PROBE_SIDECAR_READY_WAIT_MS");
const RUNNERS_WAIT_MS = numberSetting("PROBE_RUNNERS_WAIT_MS");
const BOOT_REPORT_WAIT_MS = numberSetting("PROBE_BOOT_REPORT_WAIT_MS");
const SIDECAR_AUTH_HEADER = setting("PROBE_SIDECAR_AUTH_HEADER");
/** The agent↔sidecar bearer (brokered like a real agent's: MMDS, not the config drive). */
const SIDECAR_AUTH_TOKEN = setting("SIDECAR_AUTH_TOKEN");
/** integrationId → reporter id, from `r1=@smoke/…,r2=…`. */
const RUNNER_OF = new Map(
  setting("PROBE_RUNNER_INTEGRATIONS")
    .split(",")
    .map((pair) => [pair.slice(pair.indexOf("=") + 1), pair.slice(0, pair.indexOf("="))]),
);
/** The sidecar's `os.tmpdir()` (its env sets no TMPDIR): where its MITM socket dirs live. */
const SIDECAR_TMPDIR = "/tmp";

function mark(probe, value, max) {
  console.log(TAG + " agent." + probe + "=" + clean(value, max));
}

/** Mark an observation's verdict value, and each extra field as `<probe>-<field>`. */
function markObservation(probe, observation) {
  mark(probe, valueOf(observation));
  if (!observation || typeof observation !== "object") return;
  for (const [field, extra] of Object.entries(observation)) {
    if (field !== "value" && extra !== undefined && extra !== "") {
      mark(probe + "-" + field, extra, 400);
    }
  }
}

const LINE_RE = new RegExp("^" + TAG + " ([a-z0-9]+)\\.([a-z0-9-]+)=([A-Za-z0-9_.:,/-]+)$");

// ---- 1. the runners' report channel ----

const reported = new Map();
const done = new Set();
/**
 * Every runner line already printed. A runner re-sends a report it saw no ack
 * for, and the console is a bounded serial line (Firecracker drops output it
 * cannot drain): each distinct line is printed exactly once.
 */
const printed = new Set();
let finish;
const runnersDone = new Promise((resolve) => {
  finish = resolve;
});

/**
 * The runners the agent waits for: every expected one until the sidecar's
 * integration boot report says which actually spawned — a runner whose spawn
 * failed never reports, and must not hold up (or mask) the others.
 */
let awaited = new Set(EXPECTED);
/**
 * The runners' start gate: open once the sidecar's integration boot has
 * FINISHED (every spawn succeeded or failed), so no runner probes during a
 * sibling's connect budget, and a failed sibling cannot keep the gate shut.
 */
let gateOpen = false;

function checkRunnersDone() {
  if ([...awaited].every((id) => done.has(id))) finish("signalled");
}

/** A `GET` on the channel: a reported value, or the runners' start gate. */
function answer(key) {
  if (key === "agent.go") return gateOpen ? "1" : "unknown";
  return reported.get(key) || "unknown";
}

/**
 * One line from a runner connection: a `GET` (answered at once), the report's
 * {@link REPORT_END} (acked with `ok` — every line before it was processed),
 * or a marker line.
 */
function onLine(socket, state, text) {
  if (text.startsWith("GET ")) {
    state.replied = true;
    socket.end(answer(text.slice(4).trim()) + "\r\n");
    return;
  }
  if (text === REPORT_END) {
    state.replied = true;
    socket.end("ok\r\n");
    return;
  }
  const m = LINE_RE.exec(text);
  if (!m || !EXPECTED.includes(m[1])) return;
  // The console is the host's evidence: print the runner's line verbatim, once.
  if (!printed.has(text)) {
    printed.add(text);
    console.log(text);
  }
  const key = m[1] + "." + m[2];
  if (!reported.has(key)) reported.set(key, m[3]);
  if (m[2] === "done") {
    done.add(m[1]);
    checkRunnersDone();
  }
}

const server = net.createServer((socket) => {
  const state = { buf: "", replied: false };
  socket.on("data", (chunk) => {
    state.buf += chunk.toString("latin1");
    let nl;
    while (!state.replied && (nl = state.buf.indexOf("\n")) !== -1) {
      const text = state.buf.slice(0, nl).replace(/\r$/, "");
      state.buf = state.buf.slice(nl + 1);
      onLine(socket, state, text);
    }
  });
  socket.on("error", () => socket.destroy());
});
server.on("error", (err) => finish("listen-" + errorOf(err)));
server.listen(DONE_PORT, "127.0.0.1");

// ---- probe primitives ----

/** One TCP connect to `{ host, port }`: `connected`, `error:…` or `timeout`. */
function connectOnce(options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    try {
      socket = net.connect(options);
    } catch (err) {
      settle(errorOf(err));
      return;
    }
    socket.on("connect", () => settle("connected"));
    socket.on("error", (err) => settle(errorOf(err)));
  });
}

/** CONNECT example.com through the agent's forward proxy: the status line, or the error. */
async function forwardProxyConnect(attempts) {
  let last = { value: "unknown" };
  for (let i = 0; i < attempts; i++) {
    const r = await exchange("127.0.0.1", FORWARD_PROXY_PORT, CONNECT_EXAMPLE_COM, 8000);
    last = { value: r.line || r.error, detail: r.detail };
    if (r.line) return last;
    await sleep(500);
  }
  return last;
}

/** Sidecar readiness: the wait in ms, or `timeout:<last /health>:<last proxy connect>`. */
async function waitForSidecar() {
  const start = Date.now();
  let health = "never-tried";
  let proxy = "never-tried";
  while (Date.now() - start < SIDECAR_READY_WAIT_MS) {
    health = valueOf(await fetchStatus(`http://127.0.0.1:${SIDECAR_PORT}/health`, {}, 5000));
    if (health === "200") {
      proxy = await connectOnce({ host: "127.0.0.1", port: FORWARD_PROXY_PORT }, 5000);
      if (proxy === "connected") return String(Date.now() - start);
    }
    await sleep(1000);
  }
  return "timeout:health_" + health + ":proxy_" + proxy;
}

/**
 * The sidecar's integration boot report (`GET /integrations/boot-report`,
 * sidecar-auth only). The route answers once the boot has finished, so each
 * attempt waits up to a minute; retried until BOOT_REPORT_WAIT_MS.
 */
async function fetchBootReport() {
  const deadline = Date.now() + BOOT_REPORT_WAIT_MS;
  const url = `http://127.0.0.1:${SIDECAR_PORT}/integrations/boot-report`;
  let last = "never-tried";
  while (Date.now() < deadline) {
    const attemptMs = Math.max(1000, Math.min(60_000, deadline - Date.now()));
    try {
      const res = await fetch(url, {
        headers: { [SIDECAR_AUTH_HEADER]: SIDECAR_AUTH_TOKEN },
        signal: AbortSignal.timeout(attemptMs),
      });
      if (res.ok) return { report: await res.json() };
      last = String(res.status);
    } catch (err) {
      last = errorOf(err);
    }
    await sleep(1000);
  }
  return { error: "timeout:" + last };
}

/**
 * Report the boot (`boot-report=spawned:r1,r2/failed:mitm`, one
 * `boot-error-<id>` per failure), narrow the awaited runners to the spawned
 * ones, and open the start gate — also when no report came, so the runners
 * that did spawn still probe (the host fails on the missing report).
 */
async function settleBoot() {
  const { report, error } = await fetchBootReport();
  if (report) {
    const idOf = (integrationId) => RUNNER_OF.get(integrationId) || "unknown";
    const spawned = (report.spawned || []).map((s) => idOf(s.integrationId));
    const failed = (report.failed || []).map((f) => ({
      id: idOf(f.integrationId),
      error: f.error,
    }));
    const failedIds = failed.map((f) => f.id).join(",");
    mark("boot-report", "spawned:" + spawned.join(",") + "/failed:" + failedIds, 200);
    for (const f of failed) mark("boot-error-" + f.id, f.error, 300);
    awaited = new Set(spawned.filter((id) => EXPECTED.includes(id)));
  } else {
    mark("boot-report", error);
  }
  gateOpen = true;
  checkRunnersDone();
}

/** Every LISTEN socket in the kernel's table, as uid/address:port. */
async function listenSockets() {
  const out = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const v6 = file.endsWith("6");
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      out.push("unreadable-" + (v6 ? "tcp6" : "tcp"));
      continue;
    }
    for (const row of text.split("\n").slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f.length < 8 || f[3] !== "0A") continue;
      const local = f[1].split(":");
      const port = parseInt(local[1], 16);
      const addr = v6
        ? "v6-" + local[0].toLowerCase()
        : [6, 4, 2, 0].map((i) => parseInt(local[0].slice(i, i + 2), 16)).join(".");
      out.push(f[7] + "/" + addr + ":" + port);
    }
  }
  return out.length > 0 ? out.join(",") : "none";
}

/**
 * The MITM listener's inner TLS servers sit on unix sockets in a 0700 dir the
 * sidecar creates under its tmpdir (`mitm-XXXXXX`). /tmp is 1777, so the agent
 * sees the name; the dir must be sidecar-owned 0700 and unlistable to it — a
 * non-owner then cannot resolve any name inside, so no socket there is
 * reachable. One comma-separated entry per `mitm-*` dir, in the same order
 * across both markers.
 */
async function mitmSocketDirProbes() {
  let names;
  try {
    names = (await readdir(SIDECAR_TMPDIR)).filter((name) => name.startsWith("mitm-")).sort();
  } catch (err) {
    const unlisted = "tmp-" + errorOf(err);
    mark("mitm-dir-stat", unlisted);
    mark("mitm-dir-readdir", unlisted);
    return;
  }
  const stats = [];
  const listings = [];
  for (const name of names) {
    const dir = join(SIDECAR_TMPDIR, name);
    stats.push(await stat(dir).then((st) => octal(st.mode) + ":" + st.uid, errorOf));
    listings.push(await readdir(dir).then((entries) => "listed:" + entries.length, errorOf));
  }
  mark("mitm-dir-stat", stats.join(",") || "none", 400);
  mark("mitm-dir-readdir", listings.join(",") || "none", 400);
}

// ---- 2. sidecar readiness ----

mark("sidecar-ready", await waitForSidecar());
// The integration boot runs on in the sidecar: wait for its end concurrently
// with the controls, which touch no runner.
const bootSettled = settleBoot();

// ---- 3. controls ----

markObservation(
  "platform-control",
  await timed(() => fetchStatus(CONTROL_URL, {}, FETCH_TIMEOUT_MS)),
);
markObservation("proxy-control", await timed(() => forwardProxyConnect(5)));
// Positive TLS control: a FULL TLS handshake (public roots) and `GET /` to
// example.com through the forward proxy — the same work a runner's allowed
// fetch does. Its time says whether guest TLS is merely slow.
markObservation(
  "tls-control",
  await timed(() =>
    fetchStatus(
      "https://example.com/",
      { proxy: `http://127.0.0.1:${FORWARD_PROXY_PORT}` },
      FETCH_TIMEOUT_MS,
    ),
  ),
);

// ---- 4. the runners' reports (only the runners the boot report spawned) ----

await bootSettled;
const waitTimer = setTimeout(
  () => finish("timeout:missing=" + [...awaited].filter((id) => !done.has(id)).join(",")),
  RUNNERS_WAIT_MS,
);
mark("runners-done", await runnersDone);
clearTimeout(waitTimer);

// ---- 5. agent-side probes ----

// The forward proxy still admits the agent once runner attribution is live.
markObservation("proxy-after", await timed(() => forwardProxyConnect(5)));
// A runner's listener refuses the agent (both listener kinds).
for (const id of ["r1", "mitm"]) {
  const target = hostPort(reported.get(id + ".proxy-env") || "");
  if (!target) {
    mark("via-" + id + "-listener", "no-proxy-env");
    continue;
  }
  const r = await exchange(target.host, target.port, CONNECT_EXAMPLE_COM, 8000);
  markObservation("via-" + id + "-listener", { value: r.line || r.error, detail: r.detail });
}
// The transparent plane refuses the agent.
markObservation(
  "transparent-tls",
  await timed(() =>
    tlsHandshake("127.0.0.1", TRANSPARENT_TLS_PORT, "example.com", FETCH_TIMEOUT_MS),
  ),
);
// The MITM listener's socket dir is private to the sidecar.
await mitmSocketDirProbes();
// Every LISTEN socket, taken last (after every probe that could lazily open one).
mark("listen", await listenSockets(), 2000);
server.close();
await sleep(1000);
process.exit(0);
