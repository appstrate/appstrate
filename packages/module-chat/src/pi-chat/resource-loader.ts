// SPDX-License-Identifier: Apache-2.0

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
