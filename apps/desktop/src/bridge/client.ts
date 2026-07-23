// SPDX-License-Identifier: Apache-2.0

/**
 * WebSocket bridge client.
 *
 * Connects to the Appstrate instance's desktop endpoint with the
 * Better Auth session cookie harvested from the webapp pane's session,
 * then services incoming JSON-RPC requests by dispatching to the
 * `browser-api` wrappers against the supplied `WebContents`.
 *
 * Protocol: JSON-RPC 2.0, no batching (see `protocol.ts`):
 *   server → client:  { jsonrpc, id, method, params }
 *   client → server:  { jsonrpc, id, result } | { jsonrpc, id, error: { code, message } }
 *   client → server:  { jsonrpc, method, params }   (notifications: download events)
 *
 * Reconnect: exponential backoff up to 30 s, with a `getCookieHeader()`
 * callback derived fresh on every reconnect attempt. The owner (main.ts)
 * resolves the cookie from the webapp WebContentsView's session so the
 * bridge inherits whatever auth state the user has in the embedded SPA
 * — log in there, the bridge sees it on the next reconnect.
 */

import { WebSocket } from "ws";
import type { Event, WebContents } from "electron";
import * as api from "./browser-api.ts";
import * as cdp from "./cdp.ts";
import { startDownload, type Notify } from "./downloads.ts";
import {
  ERR_EXECUTION,
  ERR_METHOD_NOT_FOUND,
  errorResponse,
  notification,
  successResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.ts";

const BRIDGE_PROTOCOL_VERSION = "1";
const BRIDGE_PATH = `/api/desktop/bridge?protocol=${BRIDGE_PROTOCOL_VERSION}`;
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface BridgeClient {
  stop(): void;
}

type Handler = (
  wc: WebContents,
  params: unknown,
  notify: Notify,
  authorizedUris: readonly string[],
) => Promise<unknown> | unknown;

function matchesAuthorizedUri(spec: string, target: string): boolean {
  try {
    const escaped = spec.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `^${escaped
      .split("**")
      .map((segment) => segment.replace(/\*/g, "[^/]*"))
      .join(".*")}$`;
    return new RegExp(pattern).test(new URL(target).href);
  } catch {
    return false;
  }
}

function assertAuthorizedBrowserState(
  wc: WebContents,
  method: string,
  params: unknown,
  authorizedUris: readonly string[],
): void {
  if (method === "browser.reset" || authorizedUris.length === 0) return;
  const p = (params ?? {}) as { url?: unknown };
  const target =
    method === "browser.navigate" || (method === "browser.download" && typeof p.url === "string")
      ? p.url
      : wc.getURL();
  if (
    typeof target !== "string" ||
    !authorizedUris.some((spec) => matchesAuthorizedUri(spec, target))
  ) {
    throw new Error(`browser command outside authorized_uris: ${method}`);
  }
}

interface CaptureSource {
  source: "local_storage" | "session_storage" | "cookie";
  key: string;
  json_path?: Array<string | number>;
}

async function captureDeclarativeFields(
  wc: WebContents,
  raw: unknown,
): Promise<{ url: string; fields: Record<string, string> }> {
  const sources = (raw as { fields?: Record<string, CaptureSource> } | undefined)?.fields;
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error("capture requires a declarative `fields` object");
  }
  const startUrl = wc.getURL();
  const fields: Record<string, string> = {};
  const storageSources: Record<string, CaptureSource> = {};
  for (const [field, source] of Object.entries(sources)) {
    if (source.source === "cookie") {
      const cookies = await wc.session.cookies.get({ url: startUrl, name: source.key });
      const value = cookies[0]?.value;
      if (value) fields[field] = applyJsonPath(value, source.json_path);
    } else {
      storageSources[field] = source;
    }
  }
  if (Object.keys(storageSources).length > 0) {
    const script = `(() => {
      const sources = ${JSON.stringify(storageSources)};
      const out = {};
      for (const [field, source] of Object.entries(sources)) {
        const storage = source.source === "local_storage" ? localStorage : sessionStorage;
        let value = storage.getItem(source.key);
        if (value == null) continue;
        if (Array.isArray(source.json_path) && source.json_path.length > 0) {
          try {
            value = JSON.parse(value);
            for (const part of source.json_path) value = value?.[part];
          } catch {
            continue;
          }
        }
        if (typeof value === "string" && value.length > 0) out[field] = value;
      }
      return out;
    })()`;
    const captured = await cdp.evaluate(wc, { script });
    if (captured && typeof captured === "object" && !Array.isArray(captured)) {
      for (const [field, value] of Object.entries(captured as Record<string, unknown>)) {
        if (typeof value === "string" && value.length > 0) fields[field] = value;
      }
    }
  }
  if (wc.getURL() !== startUrl) {
    throw new Error("page navigated while credentials were being captured");
  }
  return { url: startUrl, fields };
}

function applyJsonPath(value: string, path: Array<string | number> | undefined): string {
  if (!path || path.length === 0) return value;
  let current: unknown;
  try {
    current = JSON.parse(value);
  } catch {
    return "";
  }
  for (const part of path) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string | number, unknown>)[part];
  }
  return typeof current === "string" ? current : "";
}

const handlers: Record<string, Handler> = {
  "browser.release": () => null,
  "browser.reset": async (wc) => {
    await wc.loadURL("about:blank");
    return null;
  },
  "browser.navigate": (wc, p) => cdp.navigate(wc, p as cdp.CdpNavigateParams),
  "browser.click": (wc, p) => cdp.click(wc, p as cdp.CdpClickParams),
  "browser.fill": (wc, p) => cdp.fill(wc, p as cdp.CdpFillParams),
  "browser.selectOption": (wc, p) => cdp.selectOption(wc, p as cdp.CdpSelectOptionParams),
  "browser.evaluate": (wc, p) => cdp.evaluate(wc, p as cdp.CdpEvaluateParams),
  "browser.screenshot": (wc, p) => cdp.screenshot(wc, (p ?? {}) as cdp.CdpScreenshotParams),
  "browser.waitForSelector": async (wc, p) => {
    await api.waitForSelector(wc, p as api.WaitForSelectorParams);
    return null;
  },
  "browser.download": (wc, p, notify) =>
    startDownload(wc, p, notify, async (selector) => {
      await cdp.click(wc, { selector });
    }),
  "browser.batch": (wc, p, notify, authorizedUris) => runBatch(wc, p, notify, authorizedUris),
  // Capture accepts selectors only. The implementation owns the fixed
  // storage-reading script so agent-controlled JavaScript never enters
  // this write-only credential path.
  "browser.capture": (wc, p) => captureDeclarativeFields(wc, p),
};

/**
 * Sequential batch executor — the desktop half of `browser.batch`.
 * Steps arrive ALREADY substituted (the platform resolves `{{field}}`
 * per step before dispatch) and download steps arrive already minted
 * (download_id + upload_url injected platform-side). Runs each step
 * through the same handlers as single commands, stops at the first
 * failure, and reports partial results with the failing step's index
 * and error — the RPC itself succeeds; the batch outcome is data.
 */
interface BatchStep {
  method: string;
  params?: unknown;
}

async function runBatch(
  wc: WebContents,
  raw: unknown,
  notify: Notify,
  authorizedUris: readonly string[],
): Promise<{
  completed: number;
  results: unknown[];
  error?: { step: number; code: number; message: string };
}> {
  const steps = (raw as { steps?: BatchStep[] } | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error("batch requires a non-empty `steps` array"), {
      code: ERR_INVALID_PARAMS_CODE,
    });
  }
  const results: unknown[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const handler = step.method === "browser.batch" ? undefined : handlers[step.method];
    if (!handler) {
      return {
        completed: i,
        results,
        error: {
          step: i,
          code: -32601,
          message: `unknown or non-batchable method: ${step.method}`,
        },
      };
    }
    try {
      assertAuthorizedBrowserState(wc, step.method, step.params, authorizedUris);
      results.push(await handler(wc, step.params, notify, authorizedUris));
    } catch (err) {
      const code =
        err instanceof Error && typeof (err as { code?: unknown }).code === "number"
          ? (err as unknown as { code: number }).code
          : -32000;
      return {
        completed: i,
        results,
        error: { step: i, code, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return { completed: steps.length, results };
}
const ERR_INVALID_PARAMS_CODE = -32602;

async function dispatch(
  wc: WebContents,
  req: JsonRpcRequest,
  notify: Notify,
): Promise<JsonRpcResponse> {
  const handler = handlers[req.method];
  if (!handler) {
    return errorResponse(req.id, ERR_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
  }
  try {
    const authorizedUris = req.meta?.authorized_uris ?? [];
    assertAuthorizedBrowserState(wc, req.method, req.params, authorizedUris);
    const result = await handler(wc, req.params, notify, authorizedUris);
    return successResponse(req.id, result);
  } catch (err) {
    const code =
      err instanceof Error && typeof (err as { code?: unknown }).code === "number"
        ? (err as unknown as { code: number }).code
        : ERR_EXECUTION;
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(req.id, code, message);
  }
}

/**
 * Start the bridge.
 *
 * `getCookieHeader` is invoked on every (re)connect attempt — the caller
 * resolves it freshly from the webapp WebContentsView's session so the
 * bridge picks up cookie rotations (login, sign-out, session refresh).
 * Returning `null` or an empty string is treated as "user not logged in
 * yet" — the bridge sits in `disconnected`, retries on the same backoff,
 * and reconnects automatically once the user signs into the embedded SPA.
 */
export function start(opts: {
  instance: string;
  getCookieHeader: () => Promise<string | null>;
  webContents: WebContents;
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
  onError?: (err: unknown) => void;
}): BridgeClient {
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectGeneration = 0;
  let commandChain: Promise<void> = Promise.resolve();
  let activeAuthorizedUris: readonly string[] = [];

  const guardNavigation = (event: Event, target: string): void => {
    if (
      activeAuthorizedUris.length > 0 &&
      !activeAuthorizedUris.some((spec) => matchesAuthorizedUri(spec, target))
    ) {
      event.preventDefault();
      opts.onError?.(new Error(`blocked navigation outside authorized_uris: ${target}`));
    }
  };
  opts.webContents.on("will-navigate", guardNavigation);

  const url = `${opts.instance.replace(/^http/, "ws")}${BRIDGE_PATH}`;

  // Desktop-initiated JSON-RPC notifications (download.progress /
  // .completed / .failed). Best-effort: a notification raised while the
  // socket is down is dropped — the platform's download record then ages
  // out on its TTL, which the status surface reports as a timeout.
  const notify: Notify = (method, params) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(notification(method, params)));
    } else {
      opts.onError?.(new Error(`notification ${method} dropped: bridge disconnected`));
    }
  };

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const generation = ++connectGeneration;
    opts.onStateChange?.("connecting");

    // Fresh cookie on every connect. The caller reads it from the webapp
    // WebContentsView's session so the bridge stays in sync with whatever
    // auth state the user has in the embedded SPA — sign in there, the
    // bridge sees it on its next reconnect attempt.
    let cookieHeader: string | null;
    try {
      cookieHeader = await opts.getCookieHeader();
    } catch (err) {
      opts.onError?.(err);
      cookieHeader = null;
    }
    // `stop()` may have run while the asynchronous cookie read was in
    // flight. A generation check prevents that stale attempt from
    // creating a freshly authenticated socket after sign-out.
    if (stopped || generation !== connectGeneration) return;
    if (!cookieHeader) {
      opts.onStateChange?.("disconnected");
      // Cookie may show up later (user signs in in the webapp pane,
      // network heals, etc.).
      scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url, {
      headers: { Cookie: cookieHeader },
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    });
    ws = socket;

    socket.on("open", () => {
      if (stopped || ws !== socket) {
        socket.close();
        return;
      }
      backoffMs = 1_000;
      opts.onStateChange?.("connected");
    });

    socket.on("message", (raw) => {
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(raw.toString()) as JsonRpcRequest;
      } catch {
        return; // malformed → ignore
      }
      if (!req.id || !req.method) return;
      // Browser operations share one WebContents and one transient CDP
      // debugger. Serial execution prevents navigation/input races and a
      // command detaching the debugger while another still uses it.
      commandChain = commandChain
        .then(async () => {
          if (stopped || socket.readyState !== WebSocket.OPEN) return;
          activeAuthorizedUris = req.meta?.authorized_uris ?? [];
          const response = await dispatch(opts.webContents, req, notify);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(response));
          }
        })
        .catch((err) => opts.onError?.(err));
    });

    socket.on("close", () => {
      if (ws !== socket) return;
      ws = null;
      opts.onStateChange?.("disconnected");
      if (stopped) return;
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      // 'close' will fire next; surface the error so the owner can log
      // it (silently swallowing makes "WS dies after token expiry" near-
      // impossible to debug). Reconnect handling stays in the 'close'
      // listener so we don't double-schedule.
      opts.onError?.(err);
    });
  }

  void connect();

  return {
    stop(): void {
      stopped = true;
      connectGeneration++;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const socket = ws;
      ws = null;
      opts.webContents.removeListener("will-navigate", guardNavigation);
      socket?.close();
    },
  };
}
