// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the prebuilt `claude` native binary for the chat engine's Agent SDK
 * driver. Thin scope-anchored shim over the shared resolver in
 * `@appstrate/core/claude-binary`: the universal per-arch matrix + fall-through
 * logic live there; this module only pins resolution to *this* package's
 * `node_modules`, where `@appstrate/module-chat` installed the SDK.
 */

import {
  makeSdkScopeResolver,
  resolveClaudeCodeBinary as resolveBinary,
} from "@appstrate/core/claude-binary";

const resolve = makeSdkScopeResolver(import.meta.url);

/** Absolute path to the host's prebuilt `claude` binary (throws if absent). */
export function resolveClaudeCodeBinary(): string {
  return resolveBinary({ resolve });
}
