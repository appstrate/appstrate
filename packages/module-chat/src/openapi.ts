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
  // One stored conversation node returned by `GET /sessions/{id}` so the
  // client can seed `useChat({ messages })` on load. Written server-side
  // (user turn before inference, assistant turn on finalize); `content` is the
  // ai-sdk/v6 format-encoded message (UIMessage minus its id).
  ChatMessage: {
    type: "object",
    required: ["id", "parent_id", "format", "content"],
    properties: {
      id: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Server-generated message id",
      },
      parent_id: { type: ["string", "null"], maxLength: 200 },
      format: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "Storage format adapter id (e.g. ai-sdk/v6)",
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
        "List the caller's chat sessions in the current organization (most recent first).",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Sessions list",
          headers: stdHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/ChatSession" } },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createChatSession",
      tags: ["Chat"],
      summary: "Create a chat session",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { title: { type: "string", minLength: 1, maxLength: 200 } },
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
      summary: "Get a chat session with its messages",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
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
      operationId: "renameChatSession",
      tags: ["Chat"],
      summary: "Rename a chat session",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
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
        "Receives the running thread (AI SDK UIMessages) and streams the assistant turn (UIMessage stream over SSE). Inference goes through the org's configured models via the llm-proxy; tool calls dispatch through `/api/mcp` with the caller's own permissions. Message persistence is server-owned: the user turn is persisted before inference and the assistant turn when the stream finalizes (survives client disconnect). Rate limited (20/min per caller). Not invocable over MCP (streaming).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
        "400": { description: "No enabled model configured, or invalid body" },
        "402": {
          description:
            "Usage not allowed — a platform admission module (e.g. metering) blocked the turn for a system-provided model (RFC 9457 problem+json).",
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
