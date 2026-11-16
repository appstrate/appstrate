// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI contribution for the chat module — merged into the platform spec
 * at boot (absent when the module is disabled). Because these are normal
 * documented operations, the `mcp` module's meta-tools expose them to MCP
 * clients automatically (search/describe/invoke_operation).
 */

import { scopedNameRegex } from "@appstrate/core/validation";
import { chatSkillModeValues } from "@appstrate/db/schema";
import { MAX_PINNED_SKILLS } from "./skills.ts";

const problem = {
  "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
} as const;

/** `enforced_skills_unavailable`, shared by the turn and the names read. */
const enforcedSkillsUnavailableResponse = (description: string) => ({
  description: `\`enforced_skills_unavailable\` — ${description} RFC 9457 problem+json.`,
  content: problem,
});

const stdHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

export const chatComponentSchemas = {
  ChatSession: {
    type: "object",
    required: [
      "object",
      "id",
      "generating",
      "unread",
      "skill_mode",
      "pinned_skills",
      "spaceId",
      "restricted",
      "space_ids",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      object: { type: "string", enum: ["chat_session"] },
      id: { type: "string", description: "Session ID (chs_ prefix)" },
      title: { type: ["string", "null"] },
      generating: {
        type: "boolean",
        description: "Whether a turn is currently generating in this conversation.",
      },
      unread: {
        type: "boolean",
        description:
          "Whether an assistant reply landed after the caller last read the conversation. Computed server-side; cleared via PUT /api/orgs/{orgId}/chat/sessions/{id}/read.",
      },
      skill_mode: {
        type: "string",
        enum: [...chatSkillModeValues],
        description:
          "How turns use skills. `auto`: the skills of the spaces the conversation can act in (its origin space alone when it is limited) are listed and the assistant loads what fits. `manual`: the chosen skills (`pinned_skills`) are injected in full, and the assistant may still list and load others when asked. `strict`: the chosen skills are injected and the turn holds no `skills:*` permission, so it lists, loads, declares and writes no other. In every mode, the skills the origin space enforces (GET /api/orgs/{orgId}/chat/enforced-skills) are injected first. Written by the turn that carries it (POST /api/orgs/{orgId}/chat).",
      },
      pinned_skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Package ids (`@scope/name`) chosen for this conversation, sorted. Injected in `manual` and `strict`; kept but unused in `auto`.",
      },
      spaceId: {
        type: ["string", "null"],
        description:
          "The origin space: the space selected when the conversation was created, null when it was created from the overview. Not an owner: lists, filters and opening do not depend on it. It gives the enforced skills, the default space of a request naming none, and the space a limited conversation is confined to.",
      },
      restricted: {
        type: "boolean",
        description:
          "Whether the conversation is limited to its origin space: its tools act there alone, through the space-pinned MCP endpoint. Always false without an origin space.",
      },
      space_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "The touched spaces: the origin space (first), then those a tool call named by `space_id`, a `skill://` or `appfile://` read or an attachment touched, by touch time. The conversation is listed and opened only while the caller reaches every one of them with `chat:read`.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  // One stored conversation message returned by `GET /sessions/{id}` so the
  // client can seed `useChat({ messages })` on load. Written server-side
  // (user turn before inference, assistant turn on finalize); `content` is the
  // ai-sdk/v6 format-encoded message (UIMessage minus its id). The list is
  // returned in insertion order — the transcript carries no ordering field of
  // its own.
  //
  // `parent_id` and `format` were removed in `0054` along with the columns
  // behind them: a re-encoding of `seq` order and a server constant, neither
  // read by any client.
  ChatMessage: {
    type: "object",
    required: ["id", "content"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Server-generated message id",
      },
      content: { description: "Opaque encoded message" },
    },
  },
} as const;

export const chatPaths = {
  "/api/orgs/{orgId}/chat/sessions": {
    get: {
      operationId: "listChatSessions",
      tags: ["Chat"],
      summary: "List chat sessions",
      description:
        'List every conversation the caller can open in the organization, most recent activity (`updatedAt`) first: their own whose touched spaces they all reach with `chat:read`; with `?spaceId=`, those whose touched spaces include that space, or that touched none yet (a conversation that has acted nowhere holds no space data). Ignores `X-Space-Id` (like every `/api/orgs/{orgId}` route); admitted when some reachable space grants `chat:read`. A credential pinned to a space is refused (403). Keyset-paginated: when `hasMore` is `true`, pass the last session\'s `id` as `?startingAfter=`, or follow the RFC 5988 `Link: <…>; rel="next"` response header. A session whose activity moves it to the head while you page is not repeated later in that walk; re-read the first page to see it.',
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        {
          name: "limit",
          in: "query",
          description: "Page size. Out-of-range or non-numeric values fall back to 100.",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
        {
          name: "spaceId",
          in: "query",
          description:
            "Keep the conversations that touched this space or no space yet; the space is one the caller must read with `chat:read` (else a 400 naming `spaceId`). The cursor and the page size apply within the filtered list.",
          schema: { type: "string" },
        },
        {
          name: "q",
          in: "query",
          description:
            "Case-insensitive substring search on the session title (`%`, `_` and `\\` match literally). Surrounding whitespace is ignored; blank means no filter. Untitled sessions never match. Combines with `startingAfter` and `limit`. Longer than 200 characters is a 400.",
          schema: { type: "string", maxLength: 200 },
        },
        {
          name: "startingAfter",
          in: "query",
          description:
            "Keyset cursor — the `id` of the last session of the previous page. An id that is not one of the caller's sessions in this (filtered) list is a 400.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Sessions page",
          headers: { ...stdHeaders, Link: { $ref: "#/components/headers/Link" } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/ChatSession" } },
                  hasMore: {
                    type: "boolean",
                    description: "True when older sessions follow this page.",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createChatSession",
      tags: ["Chat"],
      summary: "Create a chat session",
      description:
        "Starts a conversation of the organization and its author. `spaceId` is its origin space — the space selected when it is created, which must be one of the spaces the conversation can act in (the reachable spaces where the caller holds `chat:write`, `chat:read` and `mcp:read` together; else a 400 naming the field) — and it is touched by definition, so the conversation is listed in that space before anything else. `restricted: true` limits it to that space and needs `spaceId` (else a 400 naming the field). Ignores `X-Space-Id`; admitted when the acting set is not empty. A credential pinned to a space is refused (403).",
      parameters: [{ $ref: "#/components/parameters/OrgIdPath" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1, maxLength: 200 },
                spaceId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The origin space: the space selected when the conversation is created. Absent from the overview.",
                },
                restricted: {
                  type: "boolean",
                  description: "Limit the conversation to its origin space; needs `spaceId`.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Session created",
          headers: stdHeaders,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ChatSession" } },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (30/min per caller)",
        },
      },
    },
  },
  "/api/orgs/{orgId}/chat/sessions/{id}": {
    get: {
      operationId: "getChatSession",
      tags: ["Chat"],
      summary: "Get a chat session with its messages",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Session with full message tree",
          headers: stdHeaders,
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ChatSession" },
                  {
                    type: "object",
                    required: ["messages"],
                    properties: {
                      messages: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ChatMessage" },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateChatSession",
      tags: ["Chat"],
      summary: "Rename a chat session or change its limit",
      description:
        "`title` renames the conversation. `restricted: true` limits it to its origin space and needs an origin space the caller can act in (else a 400 naming the field); `false` lifts the limit. Changing the limit is refused while a turn is running (409 `chat_turn_in_flight`): a running turn keeps the reach it started with. At least one field is required.",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1, maxLength: 200 },
                restricted: { type: "boolean" },
              },
              minProperties: 1,
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "204": { description: "Session updated" },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`chat_turn_in_flight` — `restricted` would change while a turn is running. RFC 9457 problem+json.",
          content: problem,
        },
      },
    },
    delete: {
      operationId: "deleteChatSession",
      tags: ["Chat"],
      summary: "Delete a chat session",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Session deleted (messages cascade)" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/chat/sessions/{id}/read": {
    put: {
      operationId: "markChatSessionRead",
      tags: ["Chat"],
      summary: "Mark a chat session read",
      description:
        "Records that the caller has seen the conversation up to now (clears `unread`). Idempotent. Does not affect the session's `updatedAt` ordering.",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Session marked read" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (120/min per caller)",
        },
      },
    },
  },
  "/api/orgs/{orgId}/chat/sessions/{id}/stream": {
    get: {
      operationId: "resumeChatStream",
      tags: ["Chat"],
      summary: "Resume an in-flight chat turn",
      description:
        "Reconnect to the session's in-flight generation (the client's native AI-SDK `useChat({ resume: true })` calls this on mount). Returns the live UIMessage stream when a turn is generating, otherwise `204`. Lets a mid-inference page reload continue tokens exactly where they were.",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "AI SDK UIMessage stream (text/event-stream)",
          headers: stdHeaders,
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "204": { description: "No active stream to resume" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (120/min per caller)",
        },
      },
    },
  },
  "/api/orgs/{orgId}/chat/enforced-skills": {
    get: {
      operationId: "listChatEnforcedSkills",
      tags: ["Chat"],
      summary: "List the skills a space enforces in chat",
      description:
        "The skills `spaceId` imposes on the conversations started in it, whatever the conversation's `skill_mode` and the caller's `skills:*` grants: each turn injects their latest published `SKILL.md`. The composer shows them for a new conversation in the selected space, or for an existing conversation's origin space. Names only — the content is never returned here. Sorted by id. `spaceId` is required and must be a space the caller reads chats in (`chat:read`); else a 400 naming the field. Ignores `X-Space-Id`; admitted when some reachable space grants `chat:read`. A credential pinned to a space is refused (403).",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        {
          name: "spaceId",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 1 },
          description: "The space whose enforced skills are listed.",
        },
      ],
      responses: {
        "200": {
          description: "Enforced skills",
          headers: stdHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name", "version"],
                      properties: {
                        id: { type: "string", description: "`@scope/name` package id" },
                        name: { type: "string", description: "Display name, else the id" },
                        version: {
                          type: ["string", "null"],
                          description:
                            "Latest published version; null when none can be read now (the turn then tells the model the skill is unavailable).",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (120/min per caller)",
        },
        "503": enforcedSkillsUnavailableResponse(
          "the skills the space enforces could not be loaded.",
        ),
      },
    },
  },
  "/api/orgs/{orgId}/chat": {
    post: {
      operationId: "streamChat",
      tags: ["Chat"],
      summary: "Run a conversational turn (streaming)",
      description:
        "Receives the running thread (AI SDK UIMessages) and streams the assistant turn (UIMessage stream over SSE). Inference runs on the org's configured models: API-key models are routed through the llm-proxy (key injected server-side), OAuth-subscription models are called natively at the provider's own base URL with the access token held in memory. Either way usage is metered server-side; tool calls dispatch through the organization MCP endpoint, each space-acting call naming its `space_id` and decided in that space under the caller's role there; every space a call names (and every attachment's space) is recorded on the conversation, which stays openable only while the caller reaches all of them with `chat:read`; a call can name only a space of the acting set (the reachable spaces where the caller holds `chat:write`, `chat:read` and `mcp:read` together). A limited conversation (`restricted`) acts in its origin space alone, through the space-pinned MCP endpoint, and is refused (403) once the caller can no longer act there. The conversation's origin space is the default of a request that names no space (never a pin); `spaceId` and `restricted` set it, and are read only when this turn creates the conversation — an existing one keeps its own. Absent from the overview, where the assistant asks. Ignores `X-Space-Id`; admitted when the acting set is not empty. A credential pinned to a space is refused (403). Message persistence is server-owned: the user turn is persisted before inference and the assistant turn when the stream finalizes (survives client disconnect). Rate limited (20/min per caller). Not invocable over MCP (streaming).",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        {
          name: "X-Model-Id",
          in: "header",
          required: false,
          schema: { type: "string" },
          description: "Org model (preset id) override; defaults to the org default model.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["messages"],
              properties: {
                messages: {
                  type: "array",
                  items: { type: "object", description: "AI SDK UIMessage" },
                  minItems: 1,
                },
                modelId: { type: "string" },
                spaceId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The origin space of a conversation this turn creates, one of the spaces it can act in (else a 400 naming the field). Ignored for an existing conversation. Absent from the overview.",
                },
                restricted: {
                  type: "boolean",
                  description:
                    "Limits a conversation this turn creates to its origin space; needs `spaceId` (else a 400 naming the field). Ignored for an existing conversation.",
                },
                generation: { $ref: "#/components/schemas/ModelGenerationSettings" },
                package_authoring: {
                  type: "boolean",
                  description:
                    "Lets the assistant author packages of every type this turn (create, import, edit; for an agent, also compose one inline); absent = on. Narrows the caller's own grants, never widens them.",
                },
                skill_mode: {
                  type: "string",
                  enum: [...chatSkillModeValues],
                  description:
                    "The conversation's skill mode (see ChatSession `skill_mode`), written onto the session by this turn. Sent with `pinned_skills` or not at all; absent = the stored selection (`auto` for a new conversation).",
                },
                pinned_skills: {
                  type: "array",
                  maxItems: MAX_PINNED_SKILLS,
                  items: {
                    type: "string",
                    pattern: scopedNameRegex.source,
                    description: "`@scope/name` package id",
                  },
                  description:
                    "The skills chosen for the conversation, written with `skill_mode`. Deduped server-side; the cap applies to the array as sent.",
                },
                id: { type: "string", description: "Session id (the assistant-ui thread id)" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "AI SDK UIMessage stream (text/event-stream)",
          headers: stdHeaders,
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "No enabled model configured, or invalid body — including a message that is not a valid AI SDK UIMessage, or a last message whose JSON exceeds 256 KB.",
        },
        "402": {
          description:
            "Usage refused by the `beforeUsage` admission hook; only emitted when a module provides it. RFC 9457 problem+json; `code` is `quota_exceeded` when the org is out of credits, or `subscription_blocked` when its subscription is suspended or cancelled.",
          content: problem,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`org_deleting` — the organization's deletion is reserved, so no new metered usage is admitted. Refused whatever modules the deployment loads. Or `needs_reconnection` — the selected model's subscription credential is dead (revoked, or expired beyond refresh), so the turn is refused before inference starts rather than failing upstream. RFC 9457 problem+json. Or `model_credential_required`: the selected model has no organization credential and the caller has no usable personal credential for it.",
          content: problem,
        },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description:
            "Rate limited (20/min per caller), or `chat_capacity` — the instance is at its concurrent chat-turn cap. Both carry `Retry-After`.",
        },
        "503": {
          description:
            "`enforced_skills_unavailable` — the skills the origin space enforces could not be loaded, so the turn is refused before anything is persisted. Or `encryption_key_unavailable` — the selected model's stored credential is encrypted under a key id missing from the platform's keyring (operator configuration; nothing is flagged for reconnection). RFC 9457 problem+json.",
          content: problem,
        },
      },
    },
  },
  "/api/orgs/{orgId}/chat/sessions/{id}/stop": {
    post: {
      operationId: "stopChatStream",
      tags: ["Chat"],
      summary: "Stop an in-progress chat generation",
      description:
        "Explicitly aborts the session's in-flight generation (distinct from a client disconnect, which never cancels generation). The live stream id is resolved server-side from the session. No-op if no turn is generating.",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Stop signal accepted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (60/min per caller)",
        },
      },
    },
  },
} as const;
