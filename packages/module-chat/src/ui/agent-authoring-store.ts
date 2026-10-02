// SPDX-License-Identifier: Apache-2.0

/**
 * Agent authoring — the composer's switch for whether the assistant may create
 * agents (persistent, or composed on the fly for a one-off task).
 *
 * A PREFERENCE, not a permission: `agents:write` is checked server-side, and
 * off, the server drops it from the turn's token. Persisted per user (see
 * `user-toggle.ts`).
 */

import { createUserToggle } from "./user-toggle.ts";

const toggle = createUserToggle("appstrate.chat.agentAuthoring:");

export const bindAgentAuthoringUser = toggle.bindUser;
export const subscribeAgentAuthoring = toggle.subscribe;
export const getAgentAuthoringEnabled = toggle.get;
export const setAgentAuthoringEnabled = toggle.set;
export const useAgentAuthoringEnabled = toggle.use;
