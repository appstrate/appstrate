// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { isAttachmentUri } from "./file-uri.ts";
import { withByteCap } from "./safe-json.ts";

export const AGENT_PROMPT_PART_TYPE = "data-agent-prompt";

/** What the browser sends on its new message: never a `text`, which the turn alone resolves. */
const clientAgentPromptDataSchema = z.strictObject({
  name: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
});

/** The stored shape, which a replayed history carries back: the turn replaces its `text`. */
export const agentPromptDataSchema = clientAgentPromptDataSchema.extend({
  text: z.string().optional(),
});

/** Ceiling on the turn's last (persisted) message; attachments ride as references. */
export const CHAT_MESSAGE_MAX_BYTES = 256 * 1024;

const messageShape = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
});

function validateMessage(
  message: z.infer<typeof messageShape>,
  submitted: boolean,
  issue: (path: (string | number)[], reason: string) => void,
) {
  if (submitted && message.id === undefined) issue(["id"], "The new message requires an id.");
  let launches = 0;
  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text" && typeof part.text !== "string")
      issue(["parts", index, "text"], "A text part requires text.");
    if (part.type === AGENT_PROMPT_PART_TYPE) {
      const data = submitted ? clientAgentPromptDataSchema : agentPromptDataSchema;
      if (message.role !== "user" || ++launches > 1 || !data.safeParse(part.data).success)
        issue(
          ["parts", index, "data"],
          "A user message carries at most one agent launch: { name, title } on the new message (and the text a stored one holds).",
        );
    }
    if (part.type === "file") {
      if (typeof part.mediaType !== "string")
        issue(["parts", index, "mediaType"], "A file part requires mediaType.");
      if (!isAttachmentUri(part.url))
        issue(
          ["parts", index, "url"],
          "File attachment URI must be an 'upload://' or 'appfile://' URI.",
        );
    }
  }
}

/** A persisted message as the browser can replay it, including extension parts and optional old ids. */
export const historicalChatMessageSchema = messageShape.superRefine((message, ctx) =>
  validateMessage(message, false, (path, reason) =>
    ctx.addIssue({ code: "custom", path, message: reason }),
  ),
);

export const chatThreadMessagesSchema = z
  .array(messageShape)
  .min(1, "messages must not be empty")
  .superRefine((messages, ctx) => {
    messages.forEach((message, i) =>
      validateMessage(message, i === messages.length - 1, (path, reason) =>
        ctx.addIssue({ code: "custom", path: [i, ...path], message: reason }),
      ),
    );
    withByteCap(CHAT_MESSAGE_MAX_BYTES)(messages[messages.length - 1], ctx);
  });
