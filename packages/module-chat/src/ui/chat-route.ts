// SPDX-License-Identifier: Apache-2.0

/**
 * Where every chat call goes, and which space it names. One kind of conversation: it belongs to the
 * organization, so there is one route base. Calls that are not the chat's own (integrations,
 * uploads, run reads) keep the host's working-space headers.
 */

import { DefaultChatTransport, type UIMessage } from "ai";
import type { ChatSkillSelection } from "../skills.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import { actsIn, type ChatTransport } from "./runtime-context.ts";

/** The chat route `suffix` (`/sessions`, `` for the turn) of the transport's organization. */
export function chatPath(transport: Pick<ChatTransport, "orgId">, suffix = ""): string {
  return `/api/orgs/${transport.orgId}/chat${suffix}`;
}

/**
 * The space a new conversation takes as its origin: the one the host is looking at, when the chat
 * acts there (the server refuses a space outside the acting set). `undefined` in « Tous les espaces »
 * and in a space the chat cannot act in: the conversation then has no origin space.
 */
export function selectedOriginSpaceId(
  transport: Pick<ChatTransport, "spaceId"> | null | undefined,
  actingSpaceIds: readonly string[] | null,
): string | undefined {
  const spaceId = transport?.spaceId;
  return spaceId && actsIn(actingSpaceIds, spaceId) ? spaceId : undefined;
}

/** What a turn that creates the conversation carries: its origin space and its limit. */
export interface ConversationCreation {
  spaceId?: string;
  restricted?: true;
}

/**
 * The body of a turn: the messages, the generation settings, the authoring switch, the skills the
 * user changed (nothing changed = nothing sent) and, on the turn that creates the conversation,
 * its origin space and limit (`creation`; the server ignores them for an existing conversation).
 */
export function turnBody(args: {
  body: object | undefined;
  id: string;
  messages: UIMessage[];
  generation: ModelGenerationSettings;
  packageAuthoring: boolean;
  inlineRunsUseChatModel: boolean;
  skills: ChatSkillSelection | undefined;
  creation: ConversationCreation | undefined;
}) {
  const {
    body,
    id,
    messages,
    generation,
    packageAuthoring,
    inlineRunsUseChatModel,
    skills,
    creation,
  } = args;
  return {
    ...body,
    id,
    messages,
    generation,
    package_authoring: packageAuthoring,
    inline_runs_use_chat_model: inlineRunsUseChatModel,
    ...creation,
    ...(skills && { skill_mode: skills.skillMode, pinned_skills: skills.pinnedSkills }),
  };
}

/**
 * The transport of a conversation's turns. `useChat` keeps the first transport it sees for an id,
 * so everything it sends is read at request time: the route (a conversation can mount before the
 * host's transport is ready), the headers and the body. Resume targets the per-session stream
 * endpoint (the chat id is the conversation id).
 */
export function createTurnTransport(read: {
  getTransport: () => ChatTransport | undefined;
  headers: () => Record<string, string>;
  body: (request: { id: string; messages: UIMessage[]; body: object | undefined }) => object;
}): DefaultChatTransport<UIMessage> {
  // A turn needs the organization's route: without the host's transport there is nowhere to send it.
  const transport = (): ChatTransport => {
    const current = read.getTransport();
    if (!current) throw new Error("module-chat: a turn was sent before the host's transport");
    return current;
  };
  return new DefaultChatTransport<UIMessage>({
    credentials: "include",
    headers: read.headers,
    prepareSendMessagesRequest: (request) => ({
      api: chatPath(transport()),
      body: read.body(request),
    }),
    prepareReconnectToStreamRequest: ({ id }) => ({
      api: chatPath(transport(), `/sessions/${id}/stream`),
    }),
  });
}
