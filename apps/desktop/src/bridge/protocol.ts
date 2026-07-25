// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge wire protocol — JSON-RPC 2.0 (no batching).
 *
 *   platform → desktop:  { jsonrpc: "2.0", id, method, params }
 *   desktop → platform:  { jsonrpc: "2.0", id, result }
 *                      | { jsonrpc: "2.0", id, error: { code, message, data? } }
 *   desktop → platform:  { jsonrpc: "2.0", method, params }        (notification)
 *
 * Error codes follow the JSON-RPC 2.0 spec for the standard range and
 * reserve the implementation-defined range (-32000..-32099) for bridge
 * domain errors. Shared between the desktop client and the platform
 * module by convention (the platform has its own mirror constant table —
 * the two sides are versioned together through the bridge protocol).
 */

export const JSONRPC = "2.0" as const;

export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
/** Generic browser-side execution failure (selector missing, script threw…). */
export const ERR_EXECUTION = -32000;
/** Download could not be triggered, saved, or uploaded to the platform sink. */
export const ERR_DOWNLOAD_FAILED = -32001;
/** Tab id unknown or already closed (the platform maps this to 410). */
export const ERR_TAB_NOT_FOUND = -32002;
/** The user took the tab over; agent commands wait for a hand-back (409). */
export const ERR_TAB_PAUSED = -32003;
/** Per-run or per-window tab budget exhausted (409). */
export const ERR_TAB_QUOTA = -32004;
/** The tab belongs to the user, or to another run (403). */
export const ERR_TAB_FORBIDDEN = -32005;

export interface JsonRpcRequest {
  jsonrpc?: typeof JSONRPC;
  id: string;
  method: string;
  params?: unknown;
  /**
   * Target tab (protocol 2). Absent on `tabs.open` and on frames from a
   * protocol-1 platform, which address the implicit single surface.
   */
  tab_id?: string;
  meta?: { authorized_uris?: string[]; run_id?: string };
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: typeof JSONRPC; id: string; result: unknown }
  | { jsonrpc: typeof JSONRPC; id: string; error: JsonRpcErrorObject };

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC;
  method: string;
  params?: unknown;
}

export function successResponse(id: string, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC, id, result };
}

export function errorResponse(id: string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSONRPC, id, error: { code, message } };
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: JSONRPC, method, ...(params !== undefined ? { params } : {}) };
}
