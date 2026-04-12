// SPDX-License-Identifier: Apache-2.0
export const webhooksSchemas = {
  WebhookObject: {
    type: "object",
    description: "Webhook configuration object",
    required: [
      "id",
      "object",
      "level",
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
      level: {
        type: "string",
        enum: ["org", "application"],
        description:
          "Scoping level. `org` webhooks fire for any application in the org; `application` webhooks are pinned via `applicationId`.",
      },
      applicationId: {
        type: ["string", "null"],
        description: "Application ID (app_ prefix) when `level = 'application'`, otherwise null.",
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
