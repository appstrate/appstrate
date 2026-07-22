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

export interface JsonRpcRequest {
  jsonrpc?: typeof JSONRPC;
  id: string;
  method: string;
  params?: unknown;
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
