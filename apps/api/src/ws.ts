import type { WSContext } from "hono/ws";

// --- In-memory WebSocket channel manager ---

const connections = new Map<string, WSContext>();
const channelSubs = new Map<string, Set<string>>();
const connChannels = new Map<string, Set<string>>();

let nextId = 0;

export function addConnection(ws: WSContext): string {
  const id = `ws_${++nextId}`;
  connections.set(id, ws);
  connChannels.set(id, new Set());
  return id;
}

export function removeConnection(id: string): void {
  const channels = connChannels.get(id);
  if (channels) {
    for (const ch of channels) {
      const subs = channelSubs.get(ch);
      if (subs) {
        subs.delete(id);
        if (subs.size === 0) channelSubs.delete(ch);
      }
    }
  }
  connChannels.delete(id);
  connections.delete(id);
}

export function subscribe(id: string, channel: string): void {
  if (!channelSubs.has(channel)) {
    channelSubs.set(channel, new Set());
  }
  channelSubs.get(channel)!.add(id);
  connChannels.get(id)?.add(channel);
}

export function unsubscribe(id: string, channel: string): void {
  const subs = channelSubs.get(channel);
  if (subs) {
    subs.delete(id);
    if (subs.size === 0) channelSubs.delete(channel);
  }
  connChannels.get(id)?.delete(channel);
}

export function send(id: string, message: Record<string, unknown>): void {
  const ws = connections.get(id);
  if (ws) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Connection dead — will be cleaned up on close
    }
  }
}

export function broadcast(channel: string, message: Record<string, unknown>): void {
  const subs = channelSubs.get(channel);
  if (!subs || subs.size === 0) return;
  const payload = JSON.stringify(message);
  for (const id of subs) {
    const ws = connections.get(id);
    if (ws) {
      try {
        ws.send(payload);
      } catch {
        // Connection dead — will be cleaned up on close
      }
    }
  }
}
