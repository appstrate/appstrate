import { useEffect, useRef, useCallback } from "react";

// --- Module-level WS singleton ---

type WsMessage = Record<string, unknown>;
type WsHandler = (msg: WsMessage) => void;

let ws: WebSocket | null = null;
const subscriptions = new Map<string, Set<WsHandler>>();
let initialized = false;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function getWsUrl(): string {
  const token = localStorage.getItem("appstrate_token") || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}

function matchChannel(channel: string, msg: WsMessage): boolean {
  if (channel === "flows") {
    return msg.type === "execution_started" || msg.type === "execution_completed";
  }
  if (channel.startsWith("flow:")) {
    return (
      (msg.type === "execution_started" || msg.type === "execution_completed") &&
      msg.flowId === channel.split(":")[1]
    );
  }
  if (channel.startsWith("execution:")) {
    return msg.type === "log" && msg.executionId === channel.split(":")[1];
  }
  return false;
}

function connect() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    reconnectDelay = 1000; // reset on successful connection
    for (const channel of subscriptions.keys()) {
      ws!.send(JSON.stringify({ type: "subscribe", channel }));
    }
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "pong") return;
      for (const [channel, handlers] of subscriptions) {
        if (matchChannel(channel, msg)) {
          for (const handler of handlers) handler(msg);
        }
      }
    } catch {
      // Malformed JSON — ignore
    }
  };

  ws.onclose = () => {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };
}

function wsSubscribe(channel: string, handler: WsHandler) {
  if (!subscriptions.has(channel)) {
    subscriptions.set(channel, new Set());
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "subscribe", channel }));
    }
  }
  subscriptions.get(channel)!.add(handler);
}

function wsUnsubscribe(channel: string, handler: WsHandler) {
  const handlers = subscriptions.get(channel);
  if (!handlers) return;
  handlers.delete(handler);
  if (handlers.size === 0) {
    subscriptions.delete(channel);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "unsubscribe", channel }));
    }
  }
}

/** Call once at app root to initialize the WS connection */
export function useWebSocketInit() {
  useEffect(() => {
    if (!initialized) {
      initialized = true;
      connect();
    }
  }, []);
}

/** Subscribe to a WS channel for the lifetime of the component */
export function useWsChannel(channel: string | null, handler: WsHandler) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  const stableHandler = useCallback<WsHandler>((msg) => handlerRef.current(msg), []);

  useEffect(() => {
    if (!channel) return;
    wsSubscribe(channel, stableHandler);
    return () => wsUnsubscribe(channel, stableHandler);
  }, [channel, stableHandler]);
}
