// SPDX-License-Identifier: Apache-2.0

/**
 * Package authoring — the composer's switch for whether the assistant may
 * create, import or edit packages of any type (agents, persistent or composed
 * on the fly for a one-off task, skills, integrations, local MCP servers).
 *
 * A PREFERENCE, not a permission: each type's `<type>:write` is checked
 * server-side, and off, the server drops them all from the turn's token.
 * Per user, on unless that user turned it off (`user-flag-store.ts`).
 */

import { createUserFlag } from "./user-flag-store.ts";

const flag = createUserFlag("appstrate.chat.packageAuthoring:", true);

export const bindPackageAuthoringUser = flag.bind;
export const subscribePackageAuthoring = flag.subscribe;
export const getPackageAuthoringEnabled = flag.get;
export const setPackageAuthoringEnabled = flag.set;
export const usePackageAuthoringEnabled = flag.use;
