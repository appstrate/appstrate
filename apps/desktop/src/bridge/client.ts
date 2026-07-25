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
 *   server → client:  { jsonrpc, id, method, tab_id?, params }
 *   client → server:  { jsonrpc, id, result } | { jsonrpc, id, error: { code, message } }
 *   client → server:  { jsonrpc, method, params }   (notifications: download + tab events)
 *
 * Protocol 2 addresses a TAB rather than "the browser". Agent commands
 * (recognised by `meta.run_id`) must name their `tab_id`; user-driven
 * commands (`/api/desktop/me/command`) may omit it and act on the active
 * tab. Ownership, session partition and the `authorized_uris` boundary
 * are all properties OF THE TAB, frozen when the platform opened it.
 *
 * Reconnect: exponential backoff up to 30 s, with a `getCookieHeader()`
 * callback derived fresh on every reconnect attempt. The owner (main.ts)
 * resolves the cookie from the webapp WebContentsView's session so the
 * bridge inherits whatever auth state the user has in the embedded SPA
 * — log in there, the bridge sees it on the next reconnect.
 */

import { WebSocket } from "ws";
import type { WebContents } from "electron";
import * as api from "./browser-api.ts";
import * as cdp from "./cdp.ts";
import { startDownload, type Notify } from "./downloads.ts";
import { TabError, type TabManager, type TabOwner, type TabRecord } from "../tabs.ts";
import {
  ERR_EXECUTION,
  ERR_INVALID_PARAMS,
  ERR_METHOD_NOT_FOUND,
  ERR_TAB_FORBIDDEN,
  ERR_TAB_NOT_FOUND,
  errorResponse,
  notification,
  successResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.ts";

const BRIDGE_PROTOCOL_VERSION = "2";
const BRIDGE_PATH = `/api/desktop/bridge?protocol=${BRIDGE_PROTOCOL_VERSION}`;
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface BridgeClient {
  stop(): void;
  /**
   * Emit a desktop-initiated notification (tab lifecycle, download
   * progress). Best effort: dropped while the socket is down.
   */
  notify(method: string, params?: unknown): void;
}

type Handler = (
  wc: WebContents,
  params: unknown,
  notify: Notify,
  authorizedUris: readonly string[],
) => Promise<unknown> | unknown;

export function matchesAuthorizedUri(spec: string, target: string): boolean {
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

/**
 * Resolve the tab a command addresses.
 *
 * An agent command carries `meta.run_id` and MUST name its tab: letting
 * it fall back to "whatever is in front" would let a run drive a surface
 * the platform never leased it. A user-driven command (the manual
 * `/api/desktop/me/command` path) has no run id and acts on the active
 * tab, which is what a person means by "the browser".
 */
function resolveTab(tabs: TabManager, req: JsonRpcRequest): TabRecord {
  const runId = req.meta?.run_id;
  if (req.tab_id) {
    return tabs.require(req.tab_id, runId !== undefined ? { runId } : undefined);
  }
  if (runId !== undefined) {
    throw new TabError(ERR_INVALID_PARAMS, "agent commands must address a tab_id");
  }
  const active = tabs.activeTabId();
  if (!active) throw new TabError(ERR_TAB_NOT_FOUND, "no tab is open");
  const tab = tabs.require(active);
  // The manual API path drives USER tabs only. Ownership has to cut both
  // ways: a run never reaches a user tab, and an API caller never reaches
  // a tab a run is working in. The person physically at the machine can
  // still take a tab over through the local chrome, which pauses it.
  if (tab.owner.kind !== "user") {
    throw new TabError(ERR_TAB_FORBIDDEN, `the active tab is driven by run ${tab.owner.runId}`);
  }
  return tab;
}

/**
 * Tab lifecycle verbs. They only touch bookkeeping (and Electron view
 * creation), never the CDP debugger, so they run outside the per-tab
 * command chain.
 */
function handleTabsMethod(tabs: TabManager, req: JsonRpcRequest): unknown {
  const p = (req.params ?? {}) as {
    tab_id?: unknown;
    partition?: unknown;
    authorized_uris?: unknown;
    agent_name?: unknown;
    background?: unknown;
  };
  const runId = req.meta?.run_id;
  switch (req.method) {
    case "tabs.open": {
      // The partition is minted platform-side from the agent manifest's
      // `desktop_browser.session` mode. The desktop never derives it:
      // that is what keeps one agent's profile out of another's.
      if (typeof p.partition !== "string" || p.partition.length === 0) {
        throw new TabError(ERR_INVALID_PARAMS, "tabs.open requires a `partition` string");
      }
      const owner: TabOwner =
        runId !== undefined
          ? {
              kind: "run",
              runId,
              ...(typeof p.agent_name === "string" ? { agentName: p.agent_name } : {}),
            }
          : { kind: "user" };
      const authorizedUris = req.meta?.authorized_uris ?? [];
      const tab = tabs.open({
        owner,
        partition: p.partition,
        authorizedUris,
        background: p.background === true,
      });
      return { tab_id: tab.tabId };
    }
    case "tabs.close": {
      if (typeof p.tab_id !== "string") {
        throw new TabError(ERR_INVALID_PARAMS, "tabs.close requires `tab_id`");
      }
      // A taken-over tab stays closable by its owner: the run is done
      // with it either way, and leaving it open would leak a surface.
      tabs.require(p.tab_id, { allowPaused: true, ...(runId !== undefined ? { runId } : {}) });
      tabs.close(p.tab_id);
      return null;
    }
    case "tabs.activate": {
      if (typeof p.tab_id !== "string") {
        throw new TabError(ERR_INVALID_PARAMS, "tabs.activate requires `tab_id`");
      }
      tabs.require(p.tab_id, { allowPaused: true, ...(runId !== undefined ? { runId } : {}) });
      tabs.activate(p.tab_id);
      return null;
    }
    case "tabs.list":
      // Deliberately unfiltered: the platform holds the leases and does
      // its own filtering per run. The desktop is not the place to
      // re-derive who may see what.
      return { tabs: tabs.list() };
    default:
      throw new TabError(ERR_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
  }
}

/**
 * `human.request` — the agent stops and asks for a person.
 *
 * Deliberately NOT a browser command: it drives no page, it changes who
 * holds the tab. The platform then waits for the matching `tab.resumed`
 * before letting the run continue, so the person is never racing a
 * command that is already in flight.
 */
function handleHumanRequest(
  tabs: TabManager,
  req: JsonRpcRequest,
  onRequest: (tabId: string, message: string) => void,
): unknown {
  const message = (req.params as { message?: unknown } | undefined)?.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TabError(ERR_INVALID_PARAMS, "human.request needs a `message` for the user");
  }
  const runId = req.meta?.run_id;
  // `allowPaused`: re-asking while already waiting is legitimate (the
  // platform's wait timed out and the run asked again), and must refresh
  // the message rather than fail.
  const tab = resolveTabForLifecycle(tabs, req, runId);
  if (!tabs.requestHuman(tab.tabId, message.slice(0, 500))) {
    throw new TabError(ERR_TAB_FORBIDDEN, "only an agent-owned tab can ask for a person");
  }
  onRequest(tab.tabId, message);
  return { awaiting_human: true };
}

function resolveTabForLifecycle(
  tabs: TabManager,
  req: JsonRpcRequest,
  runId: string | undefined,
): TabRecord {
  if (!req.tab_id) throw new TabError(ERR_INVALID_PARAMS, "human.request must address a tab_id");
  return tabs.require(req.tab_id, {
    allowPaused: true,
    ...(runId !== undefined ? { runId } : {}),
  });
}

async function dispatch(
  tabs: TabManager,
  req: JsonRpcRequest,
  notify: Notify,
  onHumanRequest: (tabId: string, message: string) => void,
): Promise<JsonRpcResponse> {
  try {
    if (req.method === "human.request") {
      return successResponse(req.id, handleHumanRequest(tabs, req, onHumanRequest));
    }
    if (req.method.startsWith("tabs.")) {
      return successResponse(req.id, handleTabsMethod(tabs, req));
    }
    const handler = handlers[req.method];
    if (!handler) {
      return errorResponse(req.id, ERR_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
    }
    const tab = resolveTab(tabs, req);
    // The boundary belongs to the TAB, frozen when the platform opened
    // it. A per-command `meta` value can only ever be the fallback for
    // the user-driven path, never a way to widen an agent's perimeter.
    const authorizedUris =
      tab.authorizedUris.length > 0 ? tab.authorizedUris : (req.meta?.authorized_uris ?? []);
    assertAuthorizedBrowserState(tab.webContents, req.method, req.params, authorizedUris);
    tabs.setState(tab.tabId, "driving");
    try {
      const result = await handler(tab.webContents, req.params, notify, authorizedUris);
      return successResponse(req.id, result);
    } finally {
      tabs.setState(tab.tabId, "idle");
    }
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
  tabs: TabManager;
  /** Surface an agent's help request: banner, notification, tab strip. */
  onHumanRequest: (tabId: string, message: string) => void;
  onStateChange?: (state: "connecting" | "connected" | "disconnected") => void;
  onError?: (err: unknown) => void;
}): BridgeClient {
  let stopped = false;
  let ws: WebSocket | null = null;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectGeneration = 0;

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
      const step = async (): Promise<void> => {
        if (stopped || socket.readyState !== WebSocket.OPEN) return;
        const response = await dispatch(opts.tabs, req, notify, opts.onHumanRequest);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(response));
        }
      };
      // Commands targeting the SAME tab stay strictly ordered: they share
      // that tab's transient CDP debugger, and a second command would
      // detach it from under the first. Different tabs run in parallel —
      // that is the whole point of protocol 2. Tab lifecycle verbs touch
      // no debugger, so they bypass the chain entirely.
      if (req.method.startsWith("tabs.") || req.method === "human.request") {
        void step().catch((err) => opts.onError?.(err));
        return;
      }
      const chainKey = req.tab_id ?? opts.tabs.activeTabId() ?? "__no_tab__";
      opts.tabs.chain(chainKey, () => step().catch((err) => opts.onError?.(err)));
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
    notify,
    stop(): void {
      stopped = true;
      connectGeneration++;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
