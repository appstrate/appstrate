// SPDX-License-Identifier: Apache-2.0

/**
 * The reply to an `ask_user` call, shared by the tool (`pi-chat/ask-user.ts`),
 * the questions route and the chat UI. Dependency-free on purpose: the UI
 * imports it, and reaching it through the tool would pull the Pi SDK into the
 * browser's type graph.
 */

/** What the person answered, by question id: the option labels picked and any text typed. */
export type AskUserAnswers = Record<string, { selected: string[]; text?: string }>;

export type AskUserReply =
  { status: "answered"; answers: AskUserAnswers } | { status: "cancelled" };
