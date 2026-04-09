// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduling module — Cron scheduling for agent runs via BullMQ.
 *
 * When loaded, registers schedule CRUD routes and a BullMQ/local queue
 * worker that triggers agent runs on cron schedule.
 */

import type { Hono } from "hono";
import type { AppstrateModule } from "@appstrate/core/module";
import type { AppEnv } from "../../types/index.ts";
import { createSchedulesRouter } from "./routes.ts";
import { initScheduleWorker, shutdownScheduleWorker } from "./service.ts";

const schedulingModule: AppstrateModule = {
  manifest: { id: "scheduling", name: "Scheduling", version: "1.0.0" },

  async init() {
    await initScheduleWorker();
  },

  registerRoutes(app) {
    (app as Hono<AppEnv>).route("/api", createSchedulesRouter());
  },

  extendAppConfig(base) {
    const features = base.features as Record<string, boolean> | undefined;
    return { ...base, features: { ...features, scheduling: true } };
  },

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
