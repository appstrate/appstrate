// SPDX-License-Identifier: Apache-2.0
//
// @default/kijiji — connect.tool (run-start) MCP integration.
//
// Plain Node, NO npm deps (hand-rolled JSON-RPC 2.0 over stdio, one message
// per line). The process/docker runtime adapter runs this via `node server.js`,
// so there is no build step and nothing from npm may be imported.
//
// Tools:
//   - `login` (connect tool, run-start, NEVER exposed to the agent): performs
//     the real Kijiji CAS + OAuth login dance and CAPTURES the session cookies
//     itself — maintaining its own cookie jar and following redirects, exactly
//     like a browser / `curl -c -b -L`:
//       0. GET  https://www.kijiji.ca/api/auth/csrf            -> {csrfToken}; sets kj-ct
//       1. POST https://www.kijiji.ca/api/auth/signin/cis      -> 30x chain to the
//          CAS login form on id.kijiji.ca (jar carries kj-ct forward)
//       2. parse hidden execution / tmSessionId / service + the <form action>
//       3. POST <CAS form action> with those + the LITERAL {{email}}/{{password}}
//          placeholders. The sidecar MITM substitutes the real secret PROXY-SIDE
//          (this process is invoked with EMPTY arguments and never reads any
//          real credential). Follow the redirect chain back to www.kijiji.ca,
//          capturing every `Set-Cookie` into the jar (kj-st, kj-at, kj-ct, …).
//       4. GET  https://www.kijiji.ca/api/auth/session         -> {user:{sub}}
//          to validate the session and read the account id.
//     Returns one text content block = the JSON contract runConnectLogin
//     parses: {"outputs": {"kj_st","kj_at","kj_ct","sub"}, "expiresAt": null}.
//     The cookie VALUES come from the jar (real Set-Cookie capture), NOT from
//     any response body.
//
//   - `whoami` (agent-facing): GET https://www.kijiji.ca/api/auth/session. The
//     tool sets NO Cookie header — the MITM injects `Cookie: kj-st=…; kj-at=…;
//     kj-ct=…` from the captured session. Returns the upstream body verbatim.
//     A 401 triggers reauthOn:[401] -> the sidecar re-runs `login` + retries once.
//
// WHY THE CONNECTOR OWNS THE JAR (not the MITM): the per-integration MITM
// listener forwards each upstream response with `redirect: "manual"` and passes
// `Set-Cookie` straight back to this process (it does not follow redirects or
// harvest cookies for the login tool). So the login tool must follow the chain
// and accumulate cookies itself — which it does here. During the login phase
// the session's delivery plan is still empty (`value: ""`), so the MITM neither
// injects nor strips the `Cookie` header: the jar this process sets reaches
// upstream untouched. After `login` returns, the captured cookies become the
// session and the MITM injects them on `whoami`.
//
// NODE + HTTPS_PROXY: Node's `https.request` does NOT honour HTTPS_PROXY, so we
// open an explicit HTTP CONNECT tunnel to the proxy and run TLS over it,
// trusting the run CA via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE. No npm deps.
//
// SESSION / COOKIE MODEL — KNOWN LIMITATION: Kijiji's session is multiple
// cookies (kj-st, kj-at, kj-ct, …). We capture them at login and inject them as
// a single `Cookie` header. The captured cookies are a POINT-IN-TIME snapshot;
// Kijiji rotates kj-at (~30 min), so long runs rely on the reauthOn:[401]
// re-login to mint a fresh snapshot. A runner-managed cookie jar would track
// rotation more faithfully but requires a substrate change (out of scope).
//
// CONCURRENCY: each `tools/call` is dispatched WITHOUT awaiting in the stdin
// read loop. This is load-bearing — a mid-run reauth re-runs `login` while a
// data tool's upstream request is parked by the MITM; a serially-awaiting read
// loop would deadlock (the in-flight data call would block the server from
// reading the re-login request).

"use strict";

const https = require("node:https");
const http = require("node:http");
const tls = require("node:tls");
const fs = require("node:fs");
const { URL } = require("node:url");

const SERVER_INFO = { name: "appstrate-kijiji", version: "1.2.0" };
const PROTOCOL_VERSION = "2024-11-05";

const CSRF_URL = "https://www.kijiji.ca/api/auth/csrf";
const SIGNIN_CIS_URL = "https://www.kijiji.ca/api/auth/signin/cis";
const SESSION_URL = "https://www.kijiji.ca/api/auth/session";
const CALLBACK_URL = "https://www.kijiji.ca/";

const TOOLS = [
  {
    name: "login",
    description:
      "Run the Kijiji CAS + OAuth login dance (csrf -> signin/cis -> CAS POST -> session), " +
      "following redirects and capturing the session cookies into a jar. Invoked at run-start " +
      "by the platform with EMPTY arguments; the MITM substitutes the {{email}}/{{password}} " +
      "placeholders proxy-side. Produces kj_st, kj_at, kj_ct + sub. NEVER exposed to the agent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whoami",
    description:
      "GET https://www.kijiji.ca/api/auth/session. The tool sets no Cookie header — the MITM " +
      "injects the captured session cookies. Returns the upstream body (the authenticated user). " +
      "A 401 triggers a transparent re-login + retry.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── stdio JSON-RPC plumbing ─────────────────────────────────────────────

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

// ─── CA / proxy plumbing ──────────────────────────────────────────────────

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

// ─── single HTTP request (no redirect following) ──────────────────────────
// Returns { status, headers, setCookies[], body }. The MITM passes Set-Cookie
// through (preserving multiplicity); Node parses res.headers["set-cookie"] into
// an array. We never follow redirects here — `httpFollow` does that.

function readResponse(res, resolve) {
  const chunks = [];
  let len = 0;
  res.on("data", (c) => {
    len += c.length;
    if (len <= 262144) chunks.push(c);
  });
  res.on("end", () => {
    const setCookie = res.headers["set-cookie"];
    resolve({
      status: res.statusCode || 0,
      headers: res.headers,
      setCookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
      body: Buffer.concat(chunks).toString("utf8"),
    });
  });
}

function httpRequestOnce(method, urlStr, { headers, body } = {}) {
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
        {
          method,
          host: target.hostname,
          port,
          path,
          headers: reqHeaders,
          servername: target.hostname,
          ca: EXTRA_CA,
        },
        (res) => readResponse(res, resolve),
      );
      req.on("error", reject);
      req.setTimeout(20000, () => req.destroy(new Error("request timeout")));
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
        req.setTimeout(20000, () => req.destroy(new Error("request timeout")));
        if (body) req.write(body);
        req.end();
      });
      tlsSocket.on("error", reject);
    });
    connectReq.on("error", reject);
    connectReq.setTimeout(20000, () => connectReq.destroy(new Error("proxy connect timeout")));
    connectReq.end();
  });
}

// ─── cookie jar + redirect-following request ──────────────────────────────

function makeJar() {
  return new Map();
}

function jarCookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function captureSetCookies(jar, setCookies) {
  for (const sc of setCookies) {
    // First "name=value" segment before the first ";". Ignore attributes.
    const firstSeg = sc.split(";")[0] || "";
    const eq = firstSeg.indexOf("=");
    if (eq <= 0) continue;
    const name = firstSeg.slice(0, eq).trim();
    const value = firstSeg.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

// Follow up to `maxRedirects` 30x hops, carrying the jar both ways. 301/302/303
// downgrade to GET (drop the body, like browsers); 307/308 preserve method+body.
async function httpFollow(jar, method, urlStr, { headers, body, maxRedirects = 10 } = {}) {
  let curMethod = method;
  let curUrl = urlStr;
  let curBody = body;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const cookie = jarCookieHeader(jar);
    const reqHeaders = Object.assign({}, headers || {});
    if (cookie) reqHeaders.Cookie = cookie;
    const res = await httpRequestOnce(curMethod, curUrl, { headers: reqHeaders, body: curBody });
    captureSetCookies(jar, res.setCookies);
    const status = res.status;
    const location = res.headers && res.headers.location;
    if (status >= 301 && status <= 308 && status !== 304 && location && hop < maxRedirects) {
      curUrl = new URL(location, curUrl).toString();
      if (status === 307 || status === 308) {
        // preserve method + body
      } else {
        curMethod = "GET";
        curBody = undefined;
        if (headers) delete headers["Content-Type"];
      }
      continue;
    }
    return { ...res, finalUrl: curUrl };
  }
  throw new Error("too many redirects");
}

// ─── form HTML parsing (hidden CAS tokens) ────────────────────────────────

function extractInputValue(html, name) {
  const attrFirst = new RegExp(
    `<input[^>]*\\bname=["']${name}["'][^>]*\\bvalue=["']([^"']*)["']`,
    "i",
  );
  const valueFirst = new RegExp(
    `<input[^>]*\\bvalue=["']([^"']*)["'][^>]*\\bname=["']${name}["']`,
    "i",
  );
  const m = html.match(attrFirst) || html.match(valueFirst);
  return m ? m[1] : null;
}

function extractFormAction(html) {
  const m = html.match(/<form[^>]*\baction=["']([^"']*)["']/i);
  return m ? m[1] : null;
}

function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// ─── login: the real CAS + OAuth dance (own jar, follows redirects) ────────

async function login() {
  const jar = makeJar();

  // Step 0 — GET /api/auth/csrf. Seeds kj-ct into the jar.
  let r0;
  try {
    r0 = await httpFollow(jar, "GET", CSRF_URL, { headers: { Accept: "application/json" } });
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
  if (!csrfToken) return textResult("login: csrfToken missing in /csrf response", true);

  // Step 1 — POST /api/auth/signin/cis. next-auth entry point; follow the
  // redirect chain (carrying the jar) to the CAS login form on id.kijiji.ca.
  const signinBody =
    `csrfToken=${encodeURIComponent(csrfToken)}` +
    `&callbackUrl=${encodeURIComponent(CALLBACK_URL)}`;
  let r1;
  try {
    r1 = await httpFollow(jar, "POST", SIGNIN_CIS_URL, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.kijiji.ca/",
      },
      body: signinBody,
    });
  } catch (e) {
    return textResult(`login: /signin/cis failed: ${e.message}`, true);
  }
  const formHtml = r1.body;
  if (!formHtml || formHtml.length < 50) {
    return textResult("login: /signin/cis form HTML too short", true);
  }

  // Step 2 — parse the hidden CAS tokens + the form action.
  const execution = extractInputValue(formHtml, "execution");
  const tmSessionId = extractInputValue(formHtml, "tmSessionId");
  const serviceRaw = extractInputValue(formHtml, "service");
  if (!execution || !serviceRaw) {
    return textResult("login: execution / service not found in form HTML", true);
  }
  const service = unescapeHtml(serviceRaw);
  const actionRaw = extractFormAction(formHtml);
  const action = actionRaw ? unescapeHtml(actionRaw) : "/login";
  const casPostUrl = new URL(action, r1.finalUrl).toString();

  // Step 3 — POST the CAS login form. The body carries the hidden tokens AND
  // the LITERAL {{email}}/{{password}} placeholders. The MITM substitutes the
  // real secret proxy-side; this process never sees the credentials. Follow the
  // redirect chain back to www.kijiji.ca, capturing every Set-Cookie.
  let loginBody =
    `execution=${encodeURIComponent(execution)}` +
    `&service=${encodeURIComponent(service)}` +
    `&_eventId=submit` +
    `&geolocation=` +
    `&username={{email}}` +
    `&password={{password}}`;
  if (tmSessionId) loginBody += `&tmSessionId=${encodeURIComponent(tmSessionId)}`;
  try {
    await httpFollow(jar, "POST", casPostUrl, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://id.kijiji.ca",
        Referer: casPostUrl,
      },
      body: loginBody,
    });
  } catch (e) {
    return textResult(`login: CAS /login failed: ${e.message}`, true);
  }

  // Step 4 — validate the session and read the account id. The jar now carries
  // the kj-* session cookies captured across the redirect chain.
  let r4;
  try {
    r4 = await httpFollow(jar, "GET", SESSION_URL, { headers: { Accept: "application/json" } });
  } catch (e) {
    return textResult(`login: /session failed: ${e.message}`, true);
  }
  if (r4.status === 401) return textResult("login: /session returned 401 — login rejected", true);
  let session;
  try {
    session = JSON.parse(r4.body);
  } catch (e) {
    return textResult("login: /session response not JSON", true);
  }
  const sub = session && session.user && session.user.sub;
  if (!sub) return textResult("login: session.user.sub missing — login likely rejected", true);

  // Capture the session cookies from the JAR (real Set-Cookie capture). NEVER
  // log these values.
  const outputs = {
    kj_st: jar.get("kj-st") || "",
    kj_at: jar.get("kj-at") || "",
    kj_ct: jar.get("kj-ct") || "",
    sub: String(sub),
  };
  if (!outputs.kj_st || !outputs.kj_at) {
    return textResult("login: session cookies (kj-st / kj-at) not captured", true);
  }

  return textResult(JSON.stringify({ outputs, expiresAt: null }));
}

// ─── data tools (Cookie injected by the MITM) ─────────────────────────────

async function fetchInjected(urlStr) {
  // Data tools set NO Cookie header — the MITM injects the captured session.
  // No jar, no redirect following needed for the session endpoint.
  let res;
  try {
    res = await httpRequestOnce("GET", urlStr, { headers: { Accept: "application/json" } });
  } catch (e) {
    return textResult(`request failed: ${e.message}`, true);
  }
  const isError = res.status === 401;
  return textResult(JSON.stringify({ status: res.status, body: res.body }), isError);
}

// ─── dispatch ──────────────────────────────────────────────────────────────

function handle(message) {
  const method = message.method;
  const rpcId = message.id;

  if (method === "initialize") {
    result(rpcId, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === "notifications/initialized") return; // no reply expected
  if (method === "tools/list") {
    result(rpcId, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    // Dispatch WITHOUT awaiting — keep the read loop free for a concurrent
    // re-login while this tool's upstream request is parked by the MITM.
    runTool(rpcId, message.params || {});
    return;
  }
  if (method === "ping") {
    result(rpcId, {});
    return;
  }
  if (rpcId !== undefined && rpcId !== null) {
    error(rpcId, -32601, `Method not found: ${method}`);
  }
}

function runTool(rpcId, params) {
  const name = params.name;
  let p;
  if (name === "login") p = login();
  else if (name === "whoami") p = fetchInjected(SESSION_URL);
  else {
    error(rpcId, -32601, `Unknown tool: ${name}`);
    return;
  }
  p.then(
    (payload) => result(rpcId, payload),
    (e) => error(rpcId, -32603, `Internal error: ${e && e.message ? e.message : String(e)}`),
  );
}

// ─── stdin read loop (line-delimited JSON-RPC) ────────────────────────────

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
