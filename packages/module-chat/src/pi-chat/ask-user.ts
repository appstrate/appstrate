// SPDX-License-Identifier: Apache-2.0

/**
 * `ask_user`: the chat's own tool for asking the person 1 to 4 short questions
 * mid-turn (shape shared by Claude Code's `AskUserQuestion` and Codex's
 * `request_user_input`). It is not a platform MCP tool: it only means something
 * with a person in front of the screen. `execute` waits in the reply registry
 * until the questions route answers, the person skips them, or the turn ends;
 * the model always gets an explicit status, never silence.
 */

import { Type, type ExtensionFactory } from "@appstrate/runner-pi";
import type { AskUserReply } from "../ask-user-reply.ts";

export const ASK_USER_TOOL = "ask_user";

const askUserOption = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 200 })),
});

const askUserQuestion = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9_]{0,39}$" }),
  header: Type.String({ minLength: 1, maxLength: 16 }),
  question: Type.String({ minLength: 1, maxLength: 300 }),
  options: Type.Optional(Type.Array(askUserOption, { minItems: 2, maxItems: 4 })),
  multiple: Type.Optional(Type.Boolean()),
});

const askUserParameters = Type.Object({
  questions: Type.Array(askUserQuestion, { minItems: 1, maxItems: 4 }),
});

/** Wait for the person's reply to this call. Owned by the turn (registry + session). */
export type RequestAnswers = (toolCallId: string) => Promise<AskUserReply>;

const DESCRIPTION = [
  "Ask the user 1 to 4 short questions, when a decision changes what you do next and you cannot",
  "find the answer yourself (in the conversation, the platform, or its data). Ask rarely, and group",
  "related questions in one call.",
  "Each question: a stable snake_case `id`, a short `header` (16 characters at most), one sentence,",
  "and optionally 2 to 4 `options` (a label of 1 to 5 words, plus a one-line description of the",
  "trade-off). Put the option you recommend first and append a short 'Recommended' marker to its",
  "label, in the user's language. Set `multiple` when several options can apply.",
  "Never add an 'Other' option: the user can always type their own answer.",
  "Do not use this tool to ask permission for an action (writing actions are confirmed separately),",
  "nor for a yes/no you can reasonably assume.",
  'Returns {"status":"answered","answers":{"<id>":{"selected":["<label>"],"text":"<typed answer>"}}},',
  'or {"status":"cancelled"} when the user skipped the questions: then go on with your best judgement',
  "and say what you assumed.",
].join(" ");

export function createAskUserExtension(requestAnswers: RequestAnswers): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: ASK_USER_TOOL,
      label: ASK_USER_TOOL,
      description: DESCRIPTION,
      parameters: askUserParameters,
      // Pi has validated `params` against `askUserParameters` by now.
      async execute(toolCallId: string, params: { questions: Array<{ id: string }> }) {
        const ids = params.questions.map((question) => question.id);
        if (new Set(ids).size !== ids.length) {
          throw new Error("Each question needs its own id. Ask again with distinct ids.");
        }
        const reply = await requestAnswers(toolCallId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(reply) }],
          details: reply,
        };
      },
    });
  };
}
