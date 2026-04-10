// SPDX-License-Identifier: Apache-2.0
export const webhooksPaths = {
  "/api/webhooks": {
    post: {
      operationId: "createWebhook",
      tags: ["Webhooks"],
      summary: "Create a webhook",
      description:
        "Create a webhook endpoint. The secret is returned once in the response. Max 20 webhooks per org.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["url", "events"],
              properties: {
                url: { type: "string", format: "uri", description: "HTTPS endpoint URL" },
                events: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "run.started",
                      "run.success",
                      "run.failed",
                      "run.timeout",
                      "run.cancelled",
                    ],
                  },
                  description: "Event types to subscribe to",
                },
                packageId: {
                  type: ["string", "null"],
                  description: "Filter by agent ID (null = all agents)",
                },
                payloadMode: {
                  type: "string",
                  enum: ["full", "summary"],
                  default: "full",
                  description: "Payload mode: full includes result/input, summary omits them",
                },
                enabled: { type: "boolean", default: true },
              },
            },
            example: {
              url: "https://api.example.com/webhooks/appstrate",
              events: ["run.success", "run.failed"],
              packageId: null,
              payloadMode: "summary",
              enabled: true,
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
              example: {
                id: "wh_cm1abc123",
                object: "webhook",
                applicationId: "app_cm4jkl013",
                url: "https://example.com/webhooks/appstrate",
                events: ["run.success", "run.failed"],
                packageId: null,
                payloadMode: "full",
                enabled: true,
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
                secret: "whsec_k3x9m2pq7r4t1w6y0a5d8g",
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
      description:
        "List all webhooks for the current application (resolved from X-App-Id header or API key).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
              example: {
                object: "list",
                data: [
                  {
                    id: "wh_cm1abc123",
                    object: "webhook",
                    applicationId: "app_cm4jkl013",
                    url: "https://example.com/webhooks/appstrate",
                    events: ["run.success", "run.failed"],
                    packageId: null,
                    payloadMode: "full",
                    enabled: true,
                    createdAt: "2026-01-15T10:30:00Z",
                    updatedAt: "2026-01-15T10:30:00Z",
                  },
                ],
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
      description: "Get a single webhook by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookObject" },
              example: {
                id: "wh_cm1abc123",
                object: "webhook",
                applicationId: "app_cm4jkl013",
                url: "https://example.com/webhooks/appstrate",
                events: ["run.success", "run.failed"],
                packageId: null,
                payloadMode: "full",
                enabled: true,
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
              },
            },
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
        "Update webhook URL, events, filters, or enabled status. Cannot change the secret.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                url: { type: "string", format: "uri" },
                events: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: [
                      "run.started",
                      "run.success",
                      "run.failed",
                      "run.timeout",
                      "run.cancelled",
                    ],
                  },
                },
                packageId: { type: ["string", "null"] },
                payloadMode: { type: "string", enum: ["full", "summary"] },
                enabled: { type: "boolean" },
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
            "application/json": {
              schema: { $ref: "#/components/schemas/WebhookObject" },
              example: {
                id: "wh_cm1abc123",
                object: "webhook",
                applicationId: "app_cm4jkl013",
                url: "https://example.com/webhooks/appstrate",
                events: ["run.success", "run.failed"],
                packageId: null,
                payloadMode: "full",
                enabled: true,
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-20T14:00:00Z",
              },
            },
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
      description: "Delete a webhook and all its delivery history.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
        { $ref: "#/components/parameters/XAppId" },
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
              example: {
                eventId: "evt_test_cm2def456",
                payload: { type: "test.ping", webhookId: "wh_cm1abc123" },
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
        { $ref: "#/components/parameters/XAppId" },
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
              example: { secret: "whsec_n4w8s3cr3tR0t4t3dK3y" },
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
        { $ref: "#/components/parameters/XAppId" },
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
              example: {
                object: "list",
                data: [
                  {
                    id: "dlv_cm3ghi789",
                    eventId: "evt_cm3ghi790",
                    eventType: "run.success",
                    status: "success",
                    statusCode: 200,
                    latency: 142,
                    attempt: 1,
                    error: null,
                    createdAt: "2026-01-15T11:00:00Z",
                  },
                ],
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
};
