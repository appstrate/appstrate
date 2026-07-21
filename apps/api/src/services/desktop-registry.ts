// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * In-memory registry of connected Appstrate Desktop clients.
 *
 * Keyed by `userId` — the desktop app connects with the Better Auth
 * session cookie of the webapp pane it embeds, so the standard auth
 * middleware resolves the user before the upgrade handler runs. One
 * WebSocket per user; a new connection from the same user displaces
 * (and closes) the older one — desktop is single-instance per user by
 * design (see `requestSingleInstanceLock()` in `apps/desktop/src/main.ts`).
 *
 * Bidirectional dispatch: the server-side caller (`/api/desktop/me/command`
 * for smoke tests, `/internal/desktop-command` for the `desktop_browser`
 * sidecar tool) calls `sendCommand(userId, method, params)` and awaits a
 * correlated reply. Replies are matched by an in-process `id` mint; if
 * the desktop never replies within the timeout (default 30 s), the
 * promise rejects with `DesktopCommandTimeoutError`.
 *
 * Process-local only, like every other in-process registry here. A
 * multi-replica deployment needs either a sticky LB (route user X's API
 * calls to the replica their desktop connected to) or a Redis pub/sub
 * fan-out.
 */

import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.ts";

interface RegisteredClient {
  userId: string;
  send(payload: string): void;
  close(): void;
}

interface PendingCommand {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const clients = new Map<string, RegisteredClient>();
const pending = new Map<string, PendingCommand>();

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class DesktopNotConnectedError extends Error {
  constructor(userId: string) {
    super(`Desktop client not connected for user ${userId}`);
    this.name = "DesktopNotConnectedError";
  }
}

export class DesktopCommandTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Desktop command ${method} timed out after ${timeoutMs}ms`);
    this.name = "DesktopCommandTimeoutError";
  }
}

export class DesktopCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopCommandError";
  }
}

export function registerClient(client: RegisteredClient): void {
  const previous = clients.get(client.userId);
  if (previous) {
    logger.info("Desktop registry: displacing previous connection", {
      module: "desktop",
      userId: client.userId,
    });
    previous.close();
  }
  clients.set(client.userId, client);
  logger.info("Desktop registry: client registered", {
    module: "desktop",
    userId: client.userId,
    totalConnected: clients.size,
  });
}

export function unregisterClient(userId: string, client: RegisteredClient): void {
  // Only unregister if we're still the active client for this user — a
  // displaced connection's `close` event firing after the new client
  // registered must not wipe the new one out.
  const current = clients.get(userId);
  if (current === client) {
    clients.delete(userId);
    logger.info("Desktop registry: client unregistered", {
      module: "desktop",
      userId,
      totalConnected: clients.size,
    });
  }
}

export function isConnected(userId: string): boolean {
  return clients.has(userId);
}

export async function sendCommand(
  userId: string,
  method: string,
  params: unknown,
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const client = clients.get(userId);
  if (!client) throw new DesktopNotConnectedError(userId);

  const id = randomUUID();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new DesktopCommandTimeoutError(method, timeoutMs));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    client.send(JSON.stringify({ id, method, params }));
  });

  return result;
}

/**
 * Called by the WS message handler when the desktop replies. Matches by
 * `id` against the pending map and resolves the awaiting `sendCommand`.
 * Unknown ids are logged at debug and dropped — they can happen if a
 * command timed out on our side but the desktop eventually replied.
 */
export function handleClientReply(reply: {
  id?: string;
  result?: unknown;
  error?: { message?: string };
}): void {
  if (!reply.id) return;
  const entry = pending.get(reply.id);
  if (!entry) {
    logger.debug("Desktop registry: reply for unknown id (likely timed out)", {
      module: "desktop",
      id: reply.id,
    });
    return;
  }
  pending.delete(reply.id);
  clearTimeout(entry.timer);
  if (reply.error) {
    entry.reject(new DesktopCommandError(reply.error.message ?? "desktop error"));
  } else {
    entry.resolve(reply.result);
  }
}
