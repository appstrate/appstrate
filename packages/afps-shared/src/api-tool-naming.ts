// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { MCP_TOOL_NAME_MAX_LENGTH, MCP_TOOL_NAMESPACE_BASE_MAX_LENGTH } from "./mcp-naming.ts";

/** Canonical unprefixed name of the credential-injecting API tool. */
export const API_CALL_TOOL_NAME = "api_call";

/** Canonical unprefixed name of the resumable-upload companion. */
export const API_UPLOAD_TOOL_NAME = "api_upload";

// McpHost can append `_999` (four characters) to a colliding namespace. The
// longest synthetic prefix is `api_upload__` (12 characters), so an auth token
// gets at most 56 - 24 - 2 - 12 = 18 characters in every valid allocation.
const MCP_NAMESPACE_COLLISION_SUFFIX_MAX_LENGTH = 4;
const MCP_NAMESPACE_SEPARATOR_LENGTH = 2;
const API_UPLOAD_AUTH_PREFIX_LENGTH = `${API_UPLOAD_TOOL_NAME}__`.length;
const API_TOOL_AUTH_TOKEN_LENGTH =
  MCP_TOOL_NAME_MAX_LENGTH -
  (MCP_TOOL_NAMESPACE_BASE_MAX_LENGTH + MCP_NAMESPACE_COLLISION_SUFFIX_MAX_LENGTH) -
  MCP_NAMESPACE_SEPARATOR_LENGTH -
  API_UPLOAD_AUTH_PREFIX_LENGTH;
const API_TOOL_RAW_AUTH_KEY_MAX_LENGTH = API_TOOL_AUTH_TOKEN_LENGTH - 1;
const API_TOOL_AUTH_HASH_HEX_LENGTH = API_TOOL_AUTH_TOKEN_LENGTH - 2;

/**
 * Map an AFPS auth key onto the bounded token used in multi-auth tool names.
 *
 * Keys up to 17 characters remain verbatim. Longer keys become `h0` followed
 * by a 64-bit FNV-1a digest, producing exactly 18 characters. The two output
 * domains are disjoint by length, so a short raw key can never impersonate a
 * compacted long key. Consumers also reject duplicate tokens inside one
 * integration, making the bounded alias fail closed even under a deliberate
 * hash collision. The full auth key still travels separately in runtime
 * metadata and is never recovered by parsing this display/routing token.
 */
export function apiToolAuthToken(authKey: string): string {
  if (authKey.length <= API_TOOL_RAW_AUTH_KEY_MAX_LENGTH) return authKey;
  return `h0${fnv1a64(authKey).slice(0, API_TOOL_AUTH_HASH_HEX_LENGTH)}`;
}

/** Throw when two distinct auth keys collapse onto the same bounded token. */
export function assertUniqueApiToolAuthTokens(authKeys: readonly string[]): void {
  const owners = new Map<string, string>();
  for (const authKey of authKeys) {
    const token = apiToolAuthToken(authKey);
    const existing = owners.get(token);
    if (existing !== undefined && existing !== authKey) {
      throw new Error(
        `api tool auth-token collision between ${JSON.stringify(existing)} and ${JSON.stringify(authKey)}`,
      );
    }
    owners.set(token, authKey);
  }
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Derive the unprefixed api_call name for one auth surface. */
export function apiCallToolNameForAuth(authKey: string, multiAuth: boolean): string {
  return multiAuth ? `${API_CALL_TOOL_NAME}__${apiToolAuthToken(authKey)}` : API_CALL_TOOL_NAME;
}

/** Derive the api_upload companion while preserving the auth-scoped token. */
export function apiUploadToolNameFor(apiCallToolName: string): string {
  return `${API_UPLOAD_TOOL_NAME}${apiCallToolName.slice(API_CALL_TOOL_NAME.length)}`;
}
