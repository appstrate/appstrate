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
 * The space a new conversation or a turn names: the one the host is looking at, when the chat acts
 * there (the server refuses a space outside the acting set). `undefined` in « Vue d'ensemble » and
 * in a space the chat cannot act in: the conversation then acts in the caller's other spaces.
 */
export function turnSpaceId(
  transport: Pick<ChatTransport, "spaceId"> | null | undefined,
  actingSpaceIds: readonly string[],
): string | undefined {
  const spaceId = transport?.spaceId;
  return spaceId && actingSpaceIds.includes(spaceId) ? spaceId : undefined;
}

/**
 * The body of a turn: the messages, the generation settings, the authoring switch, the skills the
 * user changed (nothing changed = nothing sent) and the space the turn names (`turnSpaceId`).
 */
export function turnBody(args: {
  body: object | undefined;
  id: string;
  messages: UIMessage[];
  generation: ModelGenerationSettings;
  packageAuthoring: boolean;
  skills: ChatSkillSelection | undefined;
  spaceId: string | undefined;
}) {
  const { body, id, messages, generation, packageAuthoring, skills, spaceId } = args;
  return {
    ...body,
    id,
    messages,
    generation,
    package_authoring: packageAuthoring,
    ...(spaceId && { spaceId }),
    ...(skills && { skill_mode: skills.skillMode, pinned_skills: skills.pinnedSkills }),
  };
}
