// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The platform's single Bun WebSocket wiring.
 *
 * `createBunWebSocket()` returns a PAIRED `upgradeWebSocket` middleware
 * and `websocket` handler: upgrades performed by the former are only
 * serviced by the latter, and `Bun.serve` accepts exactly one
 * `websocket` handler. So this pair is core infrastructure — created
 * once here, the handler passed to `Bun.serve` in `index.ts`, and the
 * upgrade middleware imported by whoever mounts a WS route (currently
 * the `desktop` module). A module creating its own pair would upgrade
 * connections into a handler Bun never sees.
 *
 * Harmless when nothing uses it: with no WS route mounted, the handler
 * simply never receives a connection.
 */

import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

export { upgradeWebSocket, websocket as bunWebSocketHandler };
