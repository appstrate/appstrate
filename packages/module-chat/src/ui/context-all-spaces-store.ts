// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `context_all_spaces` switch, per user, off by default: each space that shows an
 * entry is recorded on the conversation.
 */

import { createUserFlag } from "./user-flag-store.ts";

const flag = createUserFlag("appstrate.chat.contextAllSpaces:", false);

export const bindContextAllSpacesUser = flag.bind;
export const getContextAllSpacesEnabled = flag.get;
export const setContextAllSpacesEnabled = flag.set;
export const useContextAllSpacesEnabled = flag.use;
