'use strict';
/*
 * Appstrate universal egress preload (Node runner).
 *
 * The sandbox's only outbound path is a CONNECT-style egress proxy handed to
 * the runner via HTTPS_PROXY/HTTP_PROXY. But third-party MCP servers use a zoo
 * of HTTP clients, most of which DON'T traverse that proxy correctly by default:
 *   - native fetch / undici  → ignore HTTP(S)_PROXY entirely
 *   - axios (built-in proxy) → sends a non-CONNECT request → 405 on a CONNECT-only proxy
 *   - request / native http  → tunnel correctly via env, but break if we drop env
 * Per-server patching is untenable (see appstrate/appstrate#779), so this preload
 * — injected via NODE_OPTIONS=--require for EVERY node integration — normalises
 * all of them onto the proxy, regardless of the library the server chose.
 *
 * Fail-open: any error here must never prevent the MCP server from starting.
 */
try {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;

  if (proxy) {
    // 1) native fetch / undici — ignores env proxy; give it an explicit dispatcher.
    //    ProxyAgent CONNECT-tunnels, so it works against a CONNECT-only egress.
    try {
      const { setGlobalDispatcher, ProxyAgent } = require('undici');
      setGlobalDispatcher(new ProxyAgent(proxy));
    } catch (e) { /* undici unavailable — skip */ }

    // 2) native http(s) default agents — CONNECT-tunnel. Covers native http,
    //    `request`/`node-fetch`, and axios instances that fall back to the
    //    global agent (see step 3).
    try {
      const http = require('http');
      const https = require('https');
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { HttpProxyAgent } = require('http-proxy-agent');
      https.globalAgent = new HttpsProxyAgent(proxy);
      http.globalAgent = new HttpProxyAgent(proxy);
    } catch (e) { /* agents unavailable — skip */ }

    // 3) Neutralise libraries' OWN env-proxy handling. axios' built-in support
    //    issues a non-CONNECT request over the HTTP proxy (→ 405 here); with the
    //    env vars gone it falls back to the now-tunneling https.globalAgent from
    //    step 2. undici already captured the URL in step 1, so this is safe.
    //    NO_PROXY is kept so sidecar-internal / loopback stays direct.
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      delete process.env[k];
    }
  }
} catch (e) {
  try {
    process.stderr.write('[appstrate-proxy-preload] non-fatal: ' + (e && e.message) + '\n');
  } catch (_) { /* ignore */ }
}
