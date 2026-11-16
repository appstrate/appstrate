// SPDX-License-Identifier: Apache-2.0

/**
 * Where every chat call goes, and which space it names. One kind of conversation: it belongs to the
 * organization, so there is one route base. Calls that are not the chat's own (integrations,
 * uploads, run reads) keep the host's working-space headers.
 */

import type { UIMessage } from "ai";
import type { ChatSkillSelection } from "../skills.ts";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import type { ChatTransport } from "./runtime-context.ts";

/** The chat route `suffix` (`/sessions`, `/enforced-skills`, `` for the turn) of the transport's organization. */
export function chatPath(transport: Pick<ChatTransport, "orgId">, suffix = ""): string {
  return `/api/orgs/${transport.orgId}/chat${suffix}`;
}

/**
 * The space a new conversation takes as its origin: the one the host is looking at, when the chat
 * acts there (the server refuses a space outside the acting set). `undefined` in « Vue d'ensemble »
 * and in a space the chat cannot act in: the conversation then has no origin space.
 */
export function selectedOriginSpaceId(
  transport: Pick<ChatTransport, "spaceId"> | null | undefined,
  actingSpaceIds: readonly string[],
): string | undefined {
  const spaceId = transport?.spaceId;
  return spaceId && actingSpaceIds.includes(spaceId) ? spaceId : undefined;
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
  skills: ChatSkillSelection | undefined;
  creation: ConversationCreation | undefined;
}) {
  const { body, id, messages, generation, packageAuthoring, skills, creation } = args;
  return {
    ...body,
    id,
    messages,
    generation,
    package_authoring: packageAuthoring,
    ...creation,
    ...(skills && { skill_mode: skills.skillMode, pinned_skills: skills.pinnedSkills }),
  };
}
