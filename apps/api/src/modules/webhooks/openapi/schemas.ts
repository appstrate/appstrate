// SPDX-License-Identifier: Apache-2.0
export const webhooksSchemas = {
  WebhookObject: {
    type: "object",
    description: "Webhook configuration object",
    required: [
      "id",
      "object",
      "applicationId",
      "url",
      "events",
      "payloadMode",
      "enabled",
      "createdAt",
    ],
    properties: {
      id: { type: "string", description: "Webhook ID (wh_ prefix)" },
      object: { type: "string", enum: ["webhook"] },
      applicationId: {
        type: "string",
        description: "Application ID (app_ prefix). All webhooks are application-scoped.",
      },
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
      packageId: { type: ["string", "null"] },
      payloadMode: { type: "string", enum: ["full", "summary"] },
      enabled: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
};
