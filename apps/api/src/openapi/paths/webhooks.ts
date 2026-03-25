export const webhooksPaths = {
  "/api/webhooks": {
    post: {
      operationId: "createWebhook",
      tags: ["Webhooks"],
      summary: "Create a webhook",
      description:
        "Create a webhook endpoint. The secret is returned once in the response. Max 20 webhooks per org. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["url", "events", "applicationId"],
              properties: {
                applicationId: {
                  type: "string",
                  description: "Application ID (app_ prefix) this webhook belongs to",
                },
                url: { type: "string", format: "uri", description: "HTTPS endpoint URL" },
                events: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "execution.started",
                      "execution.completed",
                      "execution.failed",
                      "execution.timeout",
                      "execution.cancelled",
                    ],
                  },
                  description: "Event types to subscribe to",
                },
                flowId: {
                  type: ["string", "null"],
                  description: "Filter by flow ID (null = all flows)",
                },
                payloadMode: {
                  type: "string",
                  enum: ["full", "summary"],
                  default: "full",
                  description: "Payload mode: full includes result/input, summary omits them",
                },
                active: { type: "boolean", default: true },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Webhook created. The `secret` field is shown only once.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/WebhookObject" },
                  {
                    type: "object",
                    properties: {
                      secret: {
                        type: "string",
                        description:
                          "Webhook secret (whsec_ prefix). Store securely — shown only once.",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
      },
    },
    get: {
      operationId: "listWebhooks",
      tags: ["Webhooks"],
      summary: "List webhooks",
      description: "List all webhooks for the organization. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "applicationId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter webhooks by application ID",
        },
      ],
      responses: {
        "200": {
          description: "Webhook list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/WebhookObject" } },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/webhooks/{id}": {
    get: {
      operationId: "getWebhook",
      tags: ["Webhooks"],
      summary: "Get a webhook",
      description: "Get a single webhook by ID. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Webhook detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/WebhookObject" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateWebhook",
      tags: ["Webhooks"],
      summary: "Update a webhook",
      description:
        "Update webhook URL, events, filters, or active status. Cannot change the secret. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri" },
                events: { type: "array", items: { type: "string" } },
                flowId: { type: ["string", "null"] },
                payloadMode: { type: "string", enum: ["full", "summary"] },
                active: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Webhook updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/WebhookObject" } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteWebhook",
      tags: ["Webhooks"],
      summary: "Delete a webhook",
      description: "Delete a webhook and all its delivery history. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Webhook deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/webhooks/{id}/test": {
    post: {
      operationId: "testWebhook",
      tags: ["Webhooks"],
      summary: "Send a test ping",
      description: "Send a synthetic test.ping event to verify webhook connectivity.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Test event generated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  eventId: { type: "string" },
                  payload: { type: "object" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/webhooks/{id}/rotate": {
    post: {
      operationId: "rotateWebhookSecret",
      tags: ["Webhooks"],
      summary: "Rotate webhook secret",
      description:
        "Generate a new secret. The previous secret remains valid for 24 hours (grace period). During rotation, signatures are emitted with both secrets.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "New secret generated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  secret: { type: "string", description: "New webhook secret (whsec_ prefix)" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/webhooks/{id}/deliveries": {
    get: {
      operationId: "listWebhookDeliveries",
      tags: ["Webhooks"],
      summary: "Delivery history",
      description: "List recent delivery attempts for a webhook (status, latency, response code).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": {
          description: "Delivery history",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        eventId: { type: "string" },
                        eventType: { type: "string" },
                        status: { type: "string", enum: ["pending", "success", "failed"] },
                        statusCode: { type: ["integer", "null"] },
                        latency: {
                          type: ["integer", "null"],
                          description: "Delivery latency in ms",
                        },
                        attempt: { type: "integer" },
                        error: { type: ["string", "null"] },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
