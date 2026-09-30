// SPDX-License-Identifier: Apache-2.0

/**
 * Tool approval — the composer's mode: ask before every writing tool call
 * (on, the default), or let the assistant act straight away. Sent with each
 * turn as `tool_approval`; the server holds writes only when it is on. Off
 * widens nothing: the calls still run with the user's own grants. Persisted
 * per user (see `user-toggle.ts`).
 */

import { createUserToggle } from "./user-toggle.ts";

const toggle = createUserToggle("appstrate.chat.toolApproval:");

export const bindToolApprovalUser = toggle.bindUser;
export const getToolApprovalEnabled = toggle.get;
export const setToolApprovalEnabled = toggle.set;
export const useToolApprovalEnabled = toggle.use;
