// SPDX-License-Identifier: Apache-2.0

/**
 * Inline runs on the chat's model — the composer's switch for whether the
 * inline runs a turn launches run on the conversation's model and generation
 * settings instead of the default model (`inline_runs_use_chat_model`).
 *
 * Off by default: the chat fans work out to inline runs, and the conversation's
 * model is often the most expensive one. Per user (`user-flag-store.ts`). The
 * server judges the model like any explicit one; a saved agent keeps its own.
 */

import { createUserFlag } from "./user-flag-store.ts";

const flag = createUserFlag("appstrate.chat.inlineRunModel:", false);

export const bindInlineRunModelUser = flag.bind;
export const getInlineRunModelEnabled = flag.get;
export const setInlineRunModelEnabled = flag.set;
export const useInlineRunModelEnabled = flag.use;
