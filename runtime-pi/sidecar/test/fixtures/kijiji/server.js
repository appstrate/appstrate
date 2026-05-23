// SPDX-License-Identifier: Apache-2.0
//
// Kijiji-shaped connect.tool (run-start) MCP fixture for the sidecar e2e.
//
// Replicates the /implantation `@default/kijiji` server.js login logic (same
// 4-step CAS + OAuth dance) without npm deps — plain Node, hand-rolled
// JSON-RPC 2.0 over stdio. Deliberately lives under test/fixtures/ (NOT
// scripts/system-packages) so kijiji never ships as a built-in package.
//
//   login (connect tool, run-start, hidden from the agent):
//     0. GET  https://www.kijiji.ca/api/auth/csrf            -> {csrfToken}
//     1. POST https://www.kijiji.ca/api/auth/signin/cis      -> CAS form HTML
//     2. parse hidden execution / tmSessionId / service
//     3. POST https://id.kijiji.ca/login with those + the LITERAL
//        {{email}}/{{password}} placeholders (substituted PROXY-SIDE).
//     4. GET  https://www.kijiji.ca/api/auth/session         -> {user:{sub},cookies}
//     -> {"outputs": {kj_st,kj_at,kj_ct,sub}, "expiresAt": null}
//
//   whoami:            GET https://www.kijiji.ca/api/auth/session  (Cookie injected by MITM)
//   get_conversations: GET https://capi.kijiji.ca/web/v8/conversations (Cookie injected by MITM)
//
// Each tools/call is dispatched WITHOUT awaiting in the read loop so a mid-run
// reauth (re-login) can run while a data call's upstream request is parked.

"use strict";

const https = require("node:https");
const http = require("node:http");
const tls = require("node:tls");
const fs = require("node:fs");
const { URL } = require("node:url");

const SERVER_INFO = { name: "appstrate-kijiji-fixture", version: "1.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const CSRF_URL = "https://www.kijiji.ca/api/auth/csrf";
const SIGNIN_CIS_URL = "https://www.kijiji.ca/api/auth/signin/cis";
const CAS_LOGIN_URL = "https://id.kijiji.ca/login";
const SESSION_URL = "https://www.kijiji.ca/api/auth/session";
const CONVERSATIONS_URL = "https://capi.kijiji.ca/web/v8/conversations";

const TOOLS = [
  { name: "login", description: "Kijiji CAS login dance.", inputSchema: { type: "object", properties: {} } },
  { name: "whoami", description: "GET /api/auth/session.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_conversations",
    description: "GET capi.kijiji.ca/web/v8/conversations.",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function result(rpcId, payload) {
  send({ jsonrpc: "2.0", id: rpcId, result: payload });
}
function error(rpcId, code, message) {
  send({ jsonrpc: "2.0", id: rpcId, error: { code, message } });
}
function textResult(text, isError) {
  const out = { content: [{ type: "text", text }] };
  if (isError) out.isError = true;
  return out;
}

// Node's https.request ignores HTTPS_PROXY — open an explicit CONNECT tunnel
// to the sidecar MITM proxy and run TLS over it, trusting the run CA. No deps.

function loadExtraCa() {
  const p = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
  if (!p) return undefined;
  try {
    return fs.readFileSync(p);
  } catch (e) {
    return undefined;
  }
}
const EXTRA_CA = loadExtraCa();

function proxyTarget() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch (e) {
    return null;
  }
}

function readResponse(res, resolve) {
  const chunks = [];
  let len = 0;
  res.on("data", (c) => {
    len += c.length;
    if (len <= 65536) chunks.push(c);
  });
  res.on("end", () =>
    resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }),
  );
}

function httpRequest(method, urlStr, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (e) {
      reject(new Error("bad URL: " + urlStr));
      return;
    }
    const port = Number(target.port) || 443;
    const reqHeaders = Object.assign({ Host: target.host }, headers || {});
    const path = target.pathname + target.search;
    const proxy = proxyTarget();

    // Direct (no proxy) — plain https.request, which does its own TLS.
    if (!proxy) {
      const req = https.request(
        { method, host: target.hostname, port, path, headers: reqHeaders, servername: target.hostname, ca: EXTRA_CA },
        (res) => readResponse(res, resolve),
      );
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("request timeout")));
      if (body) req.write(body);
      req.end();
      return;
    }

    // Proxy — CONNECT tunnel, then TLS over the tunnel ourselves, then issue a
    // PLAINTEXT http.request over the (already-encrypted) TLS socket. Using
    // https.request here would double-wrap TLS (EPROTO "packet length too long").
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        socket.destroy();
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname, ca: EXTRA_CA }, () => {
        const req = http.request(
          { method, path, headers: reqHeaders, createConnection: () => tlsSocket },
          (r) => readResponse(r, resolve),
        );
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("request timeout")));
        if (body) req.write(body);
        req.end();
      });
      tlsSocket.on("error", reject);
    });
    connectReq.on("error", reject);
    connectReq.setTimeout(15000, () => connectReq.destroy(new Error("proxy connect timeout")));
    connectReq.end();
  });
}

function extractInputValue(html, name) {
  const attrFirst = new RegExp(`<input[^>]*\\bname=["']${name}["'][^>]*\\bvalue=["']([^"']*)["']`, "i");
  const valueFirst = new RegExp(`<input[^>]*\\bvalue=["']([^"']*)["'][^>]*\\bname=["']${name}["']`, "i");
  const m = html.match(attrFirst) || html.match(valueFirst);
  return m ? m[1] : null;
}
function unescapeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

async function login() {
  let r0;
  try {
    r0 = await httpRequest("GET", CSRF_URL, { headers: { Accept: "application/json" } });
  } catch (e) {
    return textResult(`login: /csrf failed: ${e.message}`, true);
  }
  if (r0.status !== 200) return textResult(`login: /csrf returned status ${r0.status}`, true);
  let csrfToken;
  try {
    csrfToken = JSON.parse(r0.body).csrfToken;
  } catch (e) {
    return textResult("login: /csrf response not JSON", true);
  }
  if (!csrfToken) return textResult("login: csrfToken missing", true);

  const signinBody =
    `csrfToken=${encodeURIComponent(csrfToken)}&callbackUrl=${encodeURIComponent("https://www.kijiji.ca/")}`;
  let r1;
  try {
    r1 = await httpRequest("POST", SIGNIN_CIS_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.kijiji.ca/" },
      body: signinBody,
    });
  } catch (e) {
    return textResult(`login: /signin/cis failed: ${e.message}`, true);
  }
  const formHtml = r1.body;
  if (!formHtml || formHtml.length < 50) return textResult("login: form HTML too short", true);

  const execution = extractInputValue(formHtml, "execution");
  const tmSessionId = extractInputValue(formHtml, "tmSessionId");
  const serviceRaw = extractInputValue(formHtml, "service");
  if (!execution || !tmSessionId || !serviceRaw) {
    return textResult("login: execution / tmSessionId / service not found", true);
  }
  const service = unescapeHtml(serviceRaw);

  const loginBody =
    `execution=${encodeURIComponent(execution)}` +
    `&tmSessionId=${encodeURIComponent(tmSessionId)}` +
    `&service=${encodeURIComponent(service)}` +
    `&_eventId=submit&locale=en` +
    `&scope=${encodeURIComponent("openid email profile")}` +
    `&username={{email}}&password={{password}}`;
  try {
    await httpRequest("POST", CAS_LOGIN_URL, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://id.kijiji.ca",
        Referer: "https://id.kijiji.ca/login",
      },
      body: loginBody,
    });
  } catch (e) {
    return textResult(`login: CAS /login failed: ${e.message}`, true);
  }

  let r4;
  try {
    r4 = await httpRequest("GET", SESSION_URL, { headers: { Accept: "application/json" } });
  } catch (e) {
    return textResult(`login: /session failed: ${e.message}`, true);
  }
  if (r4.status === 401) return textResult("login: /session 401 — login rejected", true);
  let session;
  try {
    session = JSON.parse(r4.body);
  } catch (e) {
    return textResult("login: /session not JSON", true);
  }
  const sub = session && session.user && session.user.sub;
  if (!sub) return textResult("login: session.user.sub missing", true);

  const cookies = (session && session.cookies) || {};
  const outputs = {
    kj_st: cookies["kj-st"] || "",
    kj_at: cookies["kj-at"] || "",
    kj_ct: cookies["kj-ct"] || "",
    sub: String(sub),
  };
  return textResult(JSON.stringify({ outputs, expiresAt: null }));
}

async function fetchInjected(urlStr) {
  let res;
  try {
    res = await httpRequest("GET", urlStr, { headers: { Accept: "application/json" } });
  } catch (e) {
    return textResult(`request failed: ${e.message}`, true);
  }
  const isError = res.status === 401;
  return textResult(JSON.stringify({ status: res.status, body: res.body }), isError);
}

function handle(message) {
  const method = message.method;
  const rpcId = message.id;
  const params = message.params || {};
  if (method === "initialize") {
    result(rpcId, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    result(rpcId, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    runTool(rpcId, params);
    return;
  }
  if (method === "ping") {
    result(rpcId, {});
    return;
  }
  if (rpcId !== undefined && rpcId !== null) error(rpcId, -32601, `Method not found: ${method}`);
}

function runTool(rpcId, params) {
  const name = params.name;
  let p;
  if (name === "login") p = login();
  else if (name === "whoami") p = fetchInjected(SESSION_URL);
  else if (name === "get_conversations") p = fetchInjected(CONVERSATIONS_URL);
  else {
    error(rpcId, -32601, `Unknown tool: ${name}`);
    return;
  }
  p.then(
    (payload) => result(rpcId, payload),
    (e) => error(rpcId, -32603, `Internal error: ${e && e.message ? e.message : String(e)}`),
  );
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      continue;
    }
    try {
      handle(message);
    } catch (e) {
      const rpcId = message && typeof message === "object" ? message.id : undefined;
      if (rpcId !== undefined && rpcId !== null) {
        error(rpcId, -32603, `Internal error: ${e && e.message ? e.message : String(e)}`);
      }
    }
  }
});
