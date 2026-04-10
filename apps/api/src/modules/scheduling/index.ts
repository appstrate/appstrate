// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduling module — Cron scheduling for agent runs via BullMQ.
 *
 * When loaded, registers schedule CRUD routes and a BullMQ/local queue
 * worker that triggers agent runs on cron schedule.
 */

import { z } from "zod";
import type { AppstrateModule } from "@appstrate/core/module";
import { createSchedulesRouter } from "./routes.ts";
import { createScheduleSchema, updateScheduleSchema } from "./routes.ts";
import { initScheduleWorker, shutdownScheduleWorker } from "./service.ts";
import { schedulesPaths } from "./openapi/paths.ts";
import { schedulingSchemas } from "./openapi/schemas.ts";

const schedulingModule: AppstrateModule = {
  manifest: { id: "scheduling", name: "Scheduling", version: "1.0.0" },

  async init() {
    await initScheduleWorker();
  },

  createRouter() {
    return createSchedulesRouter();
  },

  openApiPaths() {
    return schedulesPaths;
  },

  openApiComponentSchemas() {
    return schedulingSchemas;
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/agents/{scope}/{name}/schedules",
        jsonSchema: z.toJSONSchema(createScheduleSchema) as Record<string, unknown>,
        description: "Create schedule",
      },
      {
        method: "PUT",
        path: "/api/schedules/{id}",
        jsonSchema: z.toJSONSchema(updateScheduleSchema) as Record<string, unknown>,
        description: "Update schedule",
      },
    ];
  },

  features: { scheduling: true },

  permissions: {
    owner: ["schedules:read", "schedules:write", "schedules:delete"],
    admin: ["schedules:read", "schedules:write", "schedules:delete"],
    member: ["schedules:read", "schedules:write", "schedules:delete"],
    viewer: ["schedules:read"],
  },

  async shutdown() {
    await shutdownScheduleWorker();
  },
};

export default schedulingModule;
