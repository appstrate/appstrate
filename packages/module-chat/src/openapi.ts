// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI contribution for the chat module — merged into the platform spec
 * at boot (absent when the module is disabled). Because these are normal
 * documented operations, the `mcp` module's meta-tools expose them to MCP
 * clients automatically (search/describe/invoke_operation).
 */

import { scopedNameRegex } from "@appstrate/core/validation";
import { MAX_PINNED_SKILLS } from "./skills.ts";

const problem = {
  "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
} as const;

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
      "skill_discovery",
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
      skill_discovery: {
        type: "boolean",
        description:
          "Whether the assistant may find skills beyond the pinned ones. On: the skills of the spaces the conversation can act in (its origin space alone when it is limited), minus the pinned ones, are listed in the context and the assistant loads what fits. Off: the turn holds no `skills:*` permission, so it lists, loads, declares and writes no other skill. Written by the turn that carries it (POST /api/orgs/{orgId}/chat).",
      },
      pinned_skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Package ids (`@scope/name`) pinned to this conversation, sorted. Injected in full on every turn, whatever `skill_discovery`.",
      },
      spaceId: {
        type: ["string", "null"],
        description:
          "The origin space: the space selected when the conversation was created, null when it was created from the overview or that space was deleted (the conversation is then detached and no longer limited). Not an owner: lists, filters and opening do not depend on it. It is the space of an act that names none (other than an inline run, a new package or a direct integration tool call, which go to the caller's personal space first), and the space a limited conversation is confined to.",
      },
      restricted: {
        type: "boolean",
        description:
          "Whether the conversation is limited to its origin space: its tools act there alone. Always false without an origin space.",
      },
      space_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "The touched spaces: the origin space (first), then those a tool call named by `space_id` or a `skill://` read, those of the files a served call or a gallery attachment named, and those a search or configuration refusal disclosed, by touch time. The conversation is listed and opened only while the caller reaches every one of them with `chat:read`.",
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
  ChatCommands: {
    type: "object",
    required: ["skills", "agents"],
    description:
      "What the composer's `/` menu offers, as the platform MCP server serves it to the caller (`skills/list`, `prompts/list`).",
    properties: {
      skills: {
        type: "array",
        description:
          "The skills the caller can read in the spaces asked, one per package (the first space's). Empty without `skills:read`.",
        items: {
          type: "object",
          required: ["id", "name", "description", "version"],
          properties: {
            id: { type: "string", description: "`@scope/name`: what `pinned_skills` holds." },
            name: { type: "string", description: "The skill's `SKILL.md` frontmatter `name`." },
            description: { type: "string" },
            version: {
              type: ["string", "null"],
              description: "The published version; null for a draft.",
            },
          },
        },
      },
      agents: {
        type: "array",
        description:
          "The agents the caller can launch, as launch prompts. Empty when the caller cannot run agents.",
        items: {
          type: "object",
          required: ["name", "title", "description", "packageId", "icon", "color"],
          properties: {
            name: {
              type: "string",
              description:
                "The prompt name (`run-<agent>`): what a `data-agent-prompt` part names.",
            },
            title: { type: "string" },
            description: { type: "string" },
            packageId: {
              type: "string",
              description: "`@scope/name`: the seed of the agent's derived colour.",
            },
            icon: {
              type: ["string", "null"],
              description:
                "The agent's chosen icon (`@appstrate/core/appearance` grammar, e.g. `lucide:bot`); null when none.",
            },
            color: {
              type: ["string", "null"],
              description: "The agent's chosen colour (a palette key); null when none.",
            },
          },
        },
      },
    },
  },
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
        'List every conversation the caller can open in the organization, most recent activity (`updatedAt`) first: their own whose touched spaces they all reach with `chat:read`; with `?spaceId=`, those whose touched spaces include that space, or that touched none yet (a conversation that has acted nowhere holds no space data). Ignores `X-Space-Id` (like every `/api/orgs/{orgId}` route); admitted when some reachable space grants `chat:read`. A credential confined to spaces (pinned to one, or carrying a space allowlist, such as the bearer of a chat turn) is refused (403). Keyset-paginated: when `hasMore` is `true`, pass the last session\'s `id` as `?startingAfter=`, or follow the RFC 5988 `Link: <…>; rel="next"` response header. A session whose activity moves it to the head while you page is not repeated later in that walk; re-read the first page to see it.',
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
        "Starts a conversation of the organization and its author. `spaceId` is its origin space — the space selected when it is created, which must be one of the spaces the conversation can act in (the reachable spaces where the caller holds `chat:write`, `chat:read` and `mcp:read` together; else a 400 naming the field) — and it is touched by definition, so the conversation is listed in that space before anything else. `restricted: true` limits it to that space and needs `spaceId` (else a 400 naming the field). Ignores `X-Space-Id`; admitted when the acting set is not empty. A credential confined to spaces (pinned to one, or carrying a space allowlist, such as the bearer of a chat turn) is refused (403).",
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
                    required: ["messages", "usage"],
                    properties: {
                      messages: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ChatMessage" },
                      },
                      usage: {
                        $ref: "#/components/schemas/TokenUsage",
                        description:
                          "Tokens of every model call metered for the conversation's turns. Runs launched from it are metered to the run.",
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
        "`title` renames the conversation. `restricted: true` limits it to its origin space, which the caller must be able to act in; `false` lifts the limit and keeps the origin. `spaceId` sets the origin of a conversation without one: once, only together with `restricted: true`, and only to a space the conversation can act in. The conversation is then listed under that space; the spaces it touched before stay recorded. Changing the limit is refused while a turn is running (409 `chat_turn_in_flight`): a running turn keeps the reach it started with.",
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
                spaceId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The origin space of a conversation without one (with `restricted: true` only).",
                },
              },
              // `title` or `restricted` (a top-level `anyOf` would read as a union of shapes).
              if: { not: { properties: { title: {} }, required: ["title"] } },
              then: { properties: { restricted: {} }, required: ["restricted"] },
              dependentSchemas: {
                spaceId: {
                  properties: { restricted: { const: true } },
                  required: ["restricted"],
                },
              },
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
  "/api/orgs/{orgId}/chat/commands": {
    get: {
      operationId: "listChatCommands",
      tags: ["Chat"],
      summary: "List the composer's commands",
      description:
        "The skills a conversation can pin and the agents the caller can launch, read as an MCP client reads the platform server (`skills/list`, `prompts/list`) with the caller's own permissions: in every space the caller can act in, or, with `?spaceId=`, in that space alone (a conversation limited to it). An agent is launched by a user message carrying a `data-agent-prompt` part (see `streamChat`). A half that cannot be read is empty; a server that cannot be reached is a 502. Rate limited (60/min per caller). Ignores `X-Space-Id`; admitted when the acting set is not empty. A credential confined to spaces is refused (403).",
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        {
          name: "spaceId",
          in: "query",
          description:
            "Read the commands in this space alone; it must be a space the caller can act in (else a 400 naming `spaceId`).",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "The commands",
          headers: stdHeaders,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ChatCommands" } },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description: "Rate limited (60/min per caller)",
        },
        "502": {
          description:
            "`bad_gateway` — the platform's MCP server could not be reached, so the commands are unknown (not empty). RFC 9457 problem+json. A half that fails to read is empty in a 200.",
          content: problem,
        },
      },
    },
  },
  "/api/orgs/{orgId}/chat": {
    post: {
      operationId: "streamChat",
      tags: ["Chat"],
      summary: "Run a conversational turn (streaming)",
      description:
        "Receives the running thread (AI SDK UIMessages) and streams the assistant turn (UIMessage stream over SSE). Inference runs on the org's configured models: API-key models are routed through the llm-proxy (key injected server-side), OAuth-subscription models are called natively at the provider's own base URL with the access token held in memory. Either way usage is metered server-side; tool calls dispatch through the organization MCP endpoint, each space-acting call naming its `space_id` and decided in that space under the caller's role there; every space a call names, and the space of a file `read_resource` reads or one attached from the file gallery when it is a space of the turn, is recorded on the conversation before the act (its own uploads, stored in the caller's personal space, record none; a call reads any other file by id in the space it names only), and every space disclosed by a search or a configuration refusal is recorded before its result is shown. The conversation stays openable only while the caller reaches all of them with `chat:read`; a call can name only a space of the acting set (the reachable spaces where the caller holds `chat:write`, `chat:read` and `mcp:read` together). A limited conversation (`restricted`) acts in its origin space alone, and is refused (403) once the caller can no longer act there. The space of a request that names none (a default, never a pin): the only space the turn can act in (a limited conversation); a space the user names; for an inline run, a new package or a direct integration tool call, the caller's personal space first, whatever their role there; for any other act, the conversation's origin space; otherwise the assistant asks. When the space so chosen cannot serve the request, the assistant stops and asks: it never activates, connects or switches space on its own. `spaceId` and `restricted` set the origin and the limit, and are read only when this turn creates the conversation — an existing one keeps its own. Ignores `X-Space-Id`; admitted when the acting set is not empty. A credential confined to spaces (pinned to one, or carrying a space allowlist, such as the bearer of a chat turn) is refused (403). A user message may carry one `data-agent-prompt` part, `{ name, title }`: a launch of an agent from the composer's menu (`listChatCommands`). The turn resolves `name` with `prompts/get` (the message text as its `request`) over the caller's own connection in the turn's spaces, before persisting the message (a name the server does not serve is a 400, nothing written), stores the launch instructions it returns in the part's `data.text`, and shows the model that text in place of the message's own on this turn and every later one. Message persistence is server-owned: the user turn is persisted before inference and the assistant turn when the stream finalizes (survives client disconnect). Rate limited (20/min per caller). Not invocable over MCP (streaming).",
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
                inline_runs_use_chat_model: {
                  type: "boolean",
                  description:
                    "Launches the inline runs of this turn on the turn's model and generation settings (`modelId` and `generation` of `POST /api/runs/inline`, judged like any explicit model); absent = off, they run on the default model. A saved agent's run keeps its own model.",
                },
                skill_discovery: {
                  type: "boolean",
                  description:
                    "Whether the assistant may find skills beyond the pinned ones (see ChatSession `skill_discovery`), written onto the session by this turn. Sent with `pinned_skills` or not at all; absent = the stored selection (on, with no pinned skill, for a new conversation).",
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
                    "The skills pinned to the conversation, written with `skill_discovery`. Deduped server-side; the cap applies to the array as sent.",
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
            "No enabled model configured, or invalid body — including a message that is not a valid AI SDK UIMessage, a last message whose JSON exceeds 256 KB, a malformed or repeated `data-agent-prompt` part, an agent name the server does not serve, or launch instructions over 64 KB.",
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
            "`org_deleting` — the organization's deletion is reserved, so no new metered usage is admitted. Refused whatever modules the deployment loads. Or `needs_reconnection` — the selected model's subscription credential is dead (revoked, or expired beyond refresh), so the turn is refused before inference starts rather than failing upstream. RFC 9457 problem+json. Or `model_credential_required`: the selected model has no organization credential and the caller has no usable personal credential for it. Or `chat_turn_scope_changed`: the conversation's limit (or its origin space) changed while the turn was starting; nothing was written, and sending the message again starts it with the new scope. Or `chat_turn_in_flight`: another turn of the conversation is running (a conversation runs one turn at a time); nothing was written, and the message can be sent again once that turn ends.",
          content: problem,
        },
        "429": {
          $ref: "#/components/responses/RateLimited",
          description:
            "Rate limited (20/min per caller), or `chat_capacity` — the instance is at its concurrent chat-turn cap. Both carry `Retry-After`.",
        },
        "503": {
          description:
            "`encryption_key_unavailable` — the selected model's stored credential is encrypted under a key id missing from the platform's keyring (operator configuration; nothing is flagged for reconnection). RFC 9457 problem+json.",
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
