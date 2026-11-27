// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `context_all_spaces` switch, per user, on by default: the assistant starts each
 * turn knowing what every space holds. Each space that shows an entry is then recorded on the
 * conversation; a user who would rather not tie it to them turns it off. The wire field stays
 * opt-in (absent = off): an API client that never sends it keeps its turns as they were.
 */

import { createUserFlag } from "./user-flag-store.ts";

const flag = createUserFlag("appstrate.chat.contextAllSpaces:", true);

export const bindContextAllSpacesUser = flag.bind;
export const getContextAllSpacesEnabled = flag.get;
export const setContextAllSpacesEnabled = flag.set;
export const useContextAllSpacesEnabled = flag.use;
