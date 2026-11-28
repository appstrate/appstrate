// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `context_all_spaces` switch, per user, on by default: the assistant starts each
 * turn knowing what every space holds. Each space that shows an entry is then recorded on the
 * conversation; a user who would rather not tie it to them turns it off. The wire field stays
 * opt-in (absent = off): an API client that never sends it gets no all-spaces context.
 */

import { LOCAL_STORAGE_KEYS, createLocalStore, flagCodec } from "@appstrate/ui/local-storage";

const flag = createLocalStore(LOCAL_STORAGE_KEYS.chatContextAllSpaces, flagCodec(true));

export const bindContextAllSpacesUser = flag.bind;
export const getContextAllSpacesEnabled = () => flag.read();
export const setContextAllSpacesEnabled = (value: boolean) => flag.write(value);
export const useContextAllSpacesEnabled = () => flag.useValue()[0];
