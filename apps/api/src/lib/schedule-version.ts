// SPDX-License-Identifier: Apache-2.0

import { schedules } from "@appstrate/db/schema";
import { sql } from "drizzle-orm";

/** Each configuration write advances the millisecond ETag, even within one clock tick. */
export const nextScheduleVersion = sql`greatest(clock_timestamp(),
  date_trunc('milliseconds', ${schedules.updatedAt}) + interval '1 millisecond')`;
