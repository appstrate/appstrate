// SPDX-License-Identifier: Apache-2.0
export const schedulingSchemas = {
  Schedule: {
    type: "object",
    required: [
      "id",
      "packageId",
      "connectionProfileId",
      "orgId",
      "cronExpression",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      packageId: { type: "string" },
      connectionProfileId: { type: "string", format: "uuid" },
      orgId: { type: "string" },
      name: { type: ["string", "null"] },
      enabled: { type: ["boolean", "null"] },
      cronExpression: { type: "string" },
      timezone: { type: ["string", "null"] },
      input: { type: "object" },
      lastRunAt: { type: ["string", "null"], format: "date-time" },
      nextRunAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      profileName: { type: ["string", "null"] },
      profileType: { type: ["string", "null"], enum: ["user", "app", null] },
      readiness: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ready", "degraded", "not_ready"] },
          totalProviders: { type: "integer" },
          connectedProviders: { type: "integer" },
          missingProviders: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
