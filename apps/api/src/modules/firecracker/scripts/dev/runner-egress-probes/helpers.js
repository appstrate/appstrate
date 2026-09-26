// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers shared by the two #1547 guest probe programs, `runner.js` and
 * `agent.js`. Plain JavaScript run by the guest's `bun`: the smoke
 * (`../smoke-runner-egress.ts`) bundles each program with this module into a
 * single file (`Bun.build`), so the runner ships as one `server.js` in the
 * probe mcp-server bundle and the agent as one `bun -e` argument.
 *
 * Every setting arrives through the environment (`PROBE_*`), set host-side by
 * the smoke: the programs carry no copy of a port, a timeout or the marker tag.
 */

import * as net from "node:net";
import * as tls from "node:tls";

/** A required `PROBE_*` setting. A missing one is a smoke bug, not a guest observation. */
export function setting(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing probe setting ${name}`);
  return value;
}

/** A required numeric `PROBE_*` setting. */
export function numberSetting(name) {
  const value = Number(setting(name));
  if (!Number.isFinite(value)) throw new Error(`probe setting ${name} is not a number`);
  return value;
}

/**
 * Keep an observation to one token the host regex can capture: no quotes,
 * braces, spaces or `=`.
 */
export function clean(value, max = 80) {
  return String(value)
    .replace(/[^A-Za-z0-9_.:,/-]/g, "_")
    .slice(0, max);
}

/**
 * An error as an observation: `error:<code>` for a string code (`ECONNREFUSED`),
 * else `error:<name>` — a DOMException's numeric `code` (23 for an
 * `AbortSignal.timeout`) says less than its name (`TimeoutError`).
 */
export function errorOf(err) {
  const code = err && err.code;
  if (typeof code === "string" && code !== "") return "error:" + code;
  return "error:" + ((err && err.name) || (code !== undefined ? String(code) : "unknown"));
}

/**
 * Everything that locates an error, as one token for a `<probe>-detail`
 * marker: code, name, message, syscall, address, port, errno — and the same
 * for its `cause` (fetch wraps the socket error there).
 */
export function errorDetail(err) {
  const fields = (e) =>
    ["code", "name", "message", "syscall", "address", "port", "errno"]
      .filter((k) => e && e[k] !== undefined && e[k] !== "")
      .map((k) => k + ":" + String(e[k]))
      .join("/");
  if (!err || typeof err !== "object") return clean(String(err), 400);
  const cause = err.cause && typeof err.cause === "object" ? "/cause/" + fields(err.cause) : "";
  return clean(fields(err) + cause, 400);
}

/**
 * A failed network probe: its verdict value (`error:<code>`, what the host
 * judges) plus its `detail` (what a human debugs). Probe runners print each
 * extra field as its own `<probe>-<field>` marker.
 */
export function failure(err) {
  return { value: errorOf(err), detail: errorDetail(err) };
}

/** The verdict value of an observation that may carry extra fields. */
export function valueOf(observation) {
  return observation && typeof observation === "object" ? observation.value : observation;
}

/** Time one async observation: the observation, with `ms` added as an extra field. */
export async function timed(run) {
  const start = Date.now();
  const observation = await run();
  const fields =
    observation && typeof observation === "object" ? observation : { value: observation };
  return Object.assign({}, fields, { ms: Date.now() - start });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A file mode's permission bits, as three octal digits. */
export function octal(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** `host:port` → `{ host, port }`, or null. */
export function hostPort(value) {
  const text = String(value);
  const i = text.lastIndexOf(":");
  const port = Number(text.slice(i + 1));
  return i > 0 && Number.isInteger(port) && port > 0 ? { host: text.slice(0, i), port } : null;
}

export const CONNECT_EXAMPLE_COM =
  "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";

/**
 * One raw TCP exchange: connect, write, settle on the first response line, an
 * error, a close or the timeout — whichever comes first.
 */
export function exchange(host, port, payload, timeoutMs) {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let settled = false;
    const socket = net.connect({ host, port });
    const settle = (error, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ connected, line: data.split("\r\n")[0], error, detail });
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n")) settle(undefined);
    });
    socket.on("error", (err) => settle(errorOf(err), errorDetail(err)));
    socket.on("close", () => settle(connected ? "closed" : "closed-before-connect"));
  });
}

/**
 * The line that closes a report on the agent channel. The agent acks on it,
 * not on the client's half-close: Bun closes an accepted socket as soon as the
 * peer's FIN arrives, before an `end` handler's write goes out, so an ack sent
 * from there never arrived and every runner re-sent its report each second.
 */
export const REPORT_END = "END";

/**
 * Deliver a report to the agent: write its lines and {@link REPORT_END}, and
 * settle "acked" only once the agent answered "ok" — i.e. it read every line.
 */
export function deliver(host, port, text, timeoutMs) {
  return new Promise((resolve) => {
    let connected = false;
    let data = "";
    let settled = false;
    const socket = net.connect({ host, port });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => settle(connected ? "timeout-after-connect" : "timeout"),
      timeoutMs,
    );
    socket.on("connect", () => {
      connected = true;
      socket.write(text + REPORT_END + "\n");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("ok\r\n")) settle("acked");
    });
    socket.on("error", (err) => settle(errorOf(err)));
    socket.on("close", () => settle(connected ? "closed-without-ack" : "closed-before-connect"));
  });
}

/**
 * A fully verified TLS handshake to host:port presenting `servername` as SNI
 * (public roots, hostname checked against `servername`): `secure` means the
 * real `servername` answered — through a splice, when host:port is the
 * transparent plane. A refusal is a reset or close; a wrong certificate is an
 * `error:<verification code>`.
 */
export function tlsHandshake(host, port, servername, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({ host, port, servername });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.on("secureConnect", () => settle("secure"));
    socket.on("error", (err) => settle(failure(err)));
    socket.on("close", () => settle("closed"));
  });
}

/** One fetch, reduced to its status (`"200"`) or its {@link failure}. */
export async function fetchStatus(url, init, timeoutMs) {
  try {
    const base = { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
    const res = await fetch(url, Object.assign(base, init || {}));
    await res.arrayBuffer().catch(() => {});
    return String(res.status);
  } catch (err) {
    return failure(err);
  }
}
