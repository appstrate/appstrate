// SPDX-License-Identifier: Apache-2.0

/**
 * The origin the chat reaches the platform's own public surfaces on
 * (`/api/models`, `/api/llm-proxy`, `/api/mcp`) instead of importing apps/api
 * internals — the same defence-in-depth the `mcp` module applies: the chat can
 * never do more than the caller's credential could over REST. Every hop carries a
 * short-lived bearer minted by this process (`loopback-auth.ts`), which the platform
 * auth pipeline re-authenticates.
 */

import { getChatEnv } from "./env.ts";

export function selfOrigin(): string {
  return getChatEnv().selfOrigin;
}
