// SPDX-License-Identifier: Apache-2.0

/**
 * Inline runs on the chat's model — the composer's switch for whether the
 * inline runs a turn launches run on the conversation's model and generation
 * settings instead of the default model (`inline_runs_use_chat_model`).
 *
 * Off by default: the chat fans work out to inline runs, and the conversation's
 * model is often the most expensive one. Per user (`@appstrate/ui/local-storage`). The
 * server judges the model like any explicit one; a saved agent keeps its own.
 */

import { LOCAL_STORAGE_KEYS, createLocalStore, flagCodec } from "@appstrate/ui/local-storage";

const flag = createLocalStore(LOCAL_STORAGE_KEYS.chatInlineRunModel, flagCodec(false));

export const bindInlineRunModelUser = flag.bind;
export const getInlineRunModelEnabled = () => flag.read();
export const setInlineRunModelEnabled = (value: boolean) => flag.write(value);
export const useInlineRunModelEnabled = () => flag.useValue()[0];
