// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI contribution for the chat module — merged into the platform spec
 * at boot (absent when the module is disabled). Because these are normal
 * documented operations, the `mcp` module's meta-tools expose them to MCP
 * clients automatically (search/describe/invoke_operation).
 */

const stdHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

const pagedHeaders = { ...stdHeaders, Link: { $ref: "#/components/headers/Link" } } as const;

function limitParam(defaultLimit: number, maxLimit: number) {
  return {
    name: "limit",
    in: "query",
    description: `Page size. Out-of-range or non-numeric values fall back to ${defaultLimit}.`,
    schema: { type: "integer", minimum: 1, maximum: maxLimit, default: defaultLimit },
  } as const;
}

export const chatComponentSchemas = {
  ChatSession: {
    type: "object",
    required: ["object", "id", "generating", "unread", "createdAt", "updatedAt"],
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
          "Whether an assistant reply landed after the caller last read the conversation. Computed server-side; cleared via PUT /api/chat/sessions/{id}/read.",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  // One stored conversation message returned by `GET /sessions/{id}` so the
  // client can seed `useChat({ messages })` on load. Written server-side
  // (user turn before inference, assistant turn on finalize); `content` is the
  // ai-sdk/v6 format-encoded message (UIMessage minus its id). The list is
  // returned in insertion order; `seq` is that order's cursor (`?since=`).
  //
  // `parent_id` and `format` were removed in `0054` along with the columns
  // behind them: a re-encoding of `seq` order and a server constant, neither
  // read by any client.
  ChatMessage: {
    type: "object",
    required: ["id", "seq", "content"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Server-generated message id",
      },
      seq: {
        type: "integer",
        format: "int64",
        description:
          "Insertion order (one sequence across all sessions, so a thread's values are not contiguous). Pass the last one as `?since=` to read the next page.",
      },
      content: { description: "Opaque encoded message" },
    },
  },
} as const;

export const chatPaths = {
  "/api/chat/sessions": {
    get: {
      operationId: "listChatSessions",
      tags: ["Chat"],
      summary: "List chat sessions",
      description:
        "List the caller's chat sessions in the current space, most recent activity (`updatedAt`) first. Keyset-paginated: when `hasMore` is `true`, pass the last session's `id` as `?startingAfter=`, or follow the RFC 5988 `Link: <…>; rel=\"next\"` response header. A session whose activity moves it to the head while you page is not repeated later in that walk; re-read the first page to see it.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        limitParam(100, 100),
        {
          name: "startingAfter",
          in: "query",
          description:
            "Keyset cursor — the `id` of the last session of the previous page. An id that is not one of the caller's sessions in this space is a 400.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Sessions page",
          headers: pagedHeaders,
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
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
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
        "429": { description: "Rate limited (30/min per caller)" },
      },
    },
  },
  "/api/chat/sessions/{id}": {
    get: {
      operationId: "getChatSession",
      tags: ["Chat"],
      summary: "Get a chat session with a page of its messages",
      description:
        'The session and its messages in insertion order, one page at a time: when `hasMore` is `true`, pass the last message\'s `seq` as `?since=`, or follow the RFC 5988 `Link: <…?since=<seq>>; rel="next"` response header. A malformed `since` is ignored (the page starts at the first message).',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "since",
          in: "query",
          description: "Sequence cursor — return only messages with `seq` greater than this.",
          schema: { type: "integer", format: "int64", minimum: 0 },
        },
        limitParam(100, 500),
      ],
      responses: {
        "200": {
          description: "Session with a page of its messages",
          headers: pagedHeaders,
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ChatSession" },
                  {
                    type: "object",
                    required: ["messages", "hasMore"],
                    properties: {
                      messages: {
                        type: "array",
                        items: { $ref: "#/components/schemas/ChatMessage" },
                      },
                      hasMore: {
                        type: "boolean",
                        description: "True when later messages follow this page.",
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
      operationId: "renameChatSession",
      tags: ["Chat"],
      summary: "Rename a chat session",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "204": { description: "Session renamed" },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteChatSession",
      tags: ["Chat"],
      summary: "Delete a chat session",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Session deleted (messages cascade)" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/chat/sessions/{id}/read": {
    put: {
      operationId: "markChatSessionRead",
      tags: ["Chat"],
      summary: "Mark a chat session read",
      description:
        "Records that the caller has seen the conversation up to now (clears `unread`). Idempotent. Does not affect the session's `updatedAt` ordering.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Session marked read" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { description: "Rate limited (120/min per caller)" },
      },
    },
  },
  "/api/chat/sessions/{id}/stream": {
    get: {
      operationId: "resumeChatStream",
      tags: ["Chat"],
      summary: "Resume an in-flight chat turn",
      description:
        "Reconnect to the session's in-flight generation (the client's native AI-SDK `useChat({ resume: true })` calls this on mount). Returns the live UIMessage stream when a turn is generating, otherwise `204`. Lets a mid-inference page reload continue tokens exactly where they were.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
        "429": { description: "Rate limited (120/min per caller)" },
      },
    },
  },
  "/api/chat": {
    post: {
      operationId: "streamChat",
      tags: ["Chat"],
      summary: "Run a conversational turn (streaming)",
      description:
        "Receives the running thread (AI SDK UIMessages) and streams the assistant turn (UIMessage stream over SSE). Inference runs on the org's configured models: API-key models are routed through the llm-proxy (key injected server-side), OAuth-subscription models are called natively at the provider's own base URL with the access token held in memory. Either way usage is metered server-side; tool calls dispatch through `/api/mcp` with the caller's own permissions. Message persistence is server-owned: the user turn is persisted before inference and the assistant turn when the stream finalizes (survives client disconnect). Rate limited (20/min per caller). Not invocable over MCP (streaming).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                generation: { $ref: "#/components/schemas/ModelGenerationSettings" },
                agent_authoring: {
                  type: "boolean",
                  description:
                    "Lets the assistant author agents (create, edit, compose inline) this turn; absent = on. Narrows the caller's own grants, never widens them.",
                },
                id: { type: "string", description: "Session id (the assistant-ui thread id)" },
              },
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
          description:
            "No enabled model configured, or invalid body — including a message that is not a valid AI SDK UIMessage, or a last message whose JSON exceeds 256 KB.",
        },
        "401": {
          description:
            'The selected model\'s subscription credential is dead (revoked, or expired beyond refresh), so the turn is refused before inference starts rather than failing upstream. RFC 9457 problem+json with `code: "needs_reconnection"`.',
        },
        "402": {
          description:
            "Usage refused by the `beforeUsage` admission hook; only emitted when a module provides it. RFC 9457 problem+json; `code` is `quota_exceeded` when the org is out of credits, or `subscription_blocked` when its subscription is suspended or cancelled.",
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`org_deleting` — the organization's deletion is reserved, so no new metered usage is admitted. Refused whatever modules the deployment loads. RFC 9457 problem+json.",
        },
        "429": { description: "Rate limited (20/min per caller)" },
      },
    },
  },
  "/api/chat/sessions/{id}/stop": {
    post: {
      operationId: "stopChatStream",
      tags: ["Chat"],
      summary: "Stop an in-progress chat generation",
      description:
        "Explicitly aborts the session's in-flight generation (distinct from a client disconnect, which never cancels generation). The live stream id is resolved server-side from the session. No-op if no turn is generating.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Stop signal accepted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { description: "Rate limited (60/min per caller)" },
      },
    },
  },
} as const;
