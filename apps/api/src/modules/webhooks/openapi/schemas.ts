// SPDX-License-Identifier: Apache-2.0

import { SPACE_ID_RE } from "../../../lib/ids.ts";
export const webhooksSchemas = {
  WebhookObject: {
    type: "object",
    description: "Webhook configuration object",
    required: [
      "id",
      "object",
      "level",
      "spaceId",
      "url",
      "events",
      "packageId",
      "payloadMode",
      "enabled",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", description: "Webhook ID (wh_ prefix)" },
      object: { type: "string", enum: ["webhook"] },
      level: {
        type: "string",
        enum: ["org", "space"],
        description:
          "Scoping level. `org` webhooks fire for any space in the org; `space` webhooks are pinned via `spaceId`.",
      },
      spaceId: {
        type: ["string", "null"],
        pattern: SPACE_ID_RE.source,
        description: "Space ID (spc_ prefix) when `level = 'space'`, otherwise null.",
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
