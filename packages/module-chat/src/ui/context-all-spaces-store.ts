// SPDX-License-Identifier: Apache-2.0

/**
 * Every space in the context — the composer's switch for whether a turn details, in the
 * assistant's context, the integrations and agents of every space the conversation can act in,
 * not only those it already depends on (`context_all_spaces`).
 *
 * Off by default: the details of every space weigh on each turn's context, and each space that
 * shows an entry is recorded on the conversation, which its author then opens only while they
 * reach all of them. Per user (`user-flag-store.ts`).
 */

import { createUserFlag } from "./user-flag-store.ts";

const flag = createUserFlag("appstrate.chat.contextAllSpaces:", false);

export const bindContextAllSpacesUser = flag.bind;
export const getContextAllSpacesEnabled = flag.get;
export const setContextAllSpacesEnabled = flag.set;
export const useContextAllSpacesEnabled = flag.use;
