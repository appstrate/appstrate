// SPDX-License-Identifier: Apache-2.0

import {
  createIsolatedResourceLoader,
  type ExtensionFactory,
  type PiCodingAgentSdk,
} from "@appstrate/runner-pi";

/**
 * Working directory and agent home of a chat turn's disposable Pi session.
 *
 * They are constants, not options: chat writes no session file, loads no
 * package resource and keeps no durable Pi state (see
 * `structured-session.ts`), so every caller — the resource loader, the agent
 * session, the in-memory SessionManager — must name the SAME two paths, and
 * nothing gets to choose others.
 */
export const PI_CHAT_CWD = "/tmp";
export const PI_CHAT_AGENT_DIR = "/tmp/pi-chat";

interface CreatePiChatResourceLoaderOptions extends Pick<
  PiCodingAgentSdk,
  "DefaultResourceLoader" | "SettingsManager"
> {
  systemPrompt: string;
  extensionFactories: ExtensionFactory[];
}

/**
 * Load only resources supplied explicitly by the Appstrate chat turn: no Pi
 * skill at all (chat skills reach the model through its own tools), and the
 * scoped Appstrate MCP extension factories passed here.
 */
export function createPiChatResourceLoader(
  options: CreatePiChatResourceLoaderOptions,
): ReturnType<typeof createIsolatedResourceLoader> {
  return createIsolatedResourceLoader({
    ...options,
    cwd: PI_CHAT_CWD,
    agentDir: PI_CHAT_AGENT_DIR,
    skillPaths: [],
  });
}
