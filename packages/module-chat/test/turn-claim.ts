// SPDX-License-Identifier: Apache-2.0

import type { ChatSkillStatusEntry } from "@appstrate/db/schema";
import type { TurnScope } from "../src/resumable.ts";

/** The scope of a session created with no origin space and no limit. */
export const UNLIMITED_SCOPE: TurnScope = { spaceId: null, restricted: false };

/** A claim that writes no verdict. */
export const NO_SKILL_STATUS: Readonly<Record<string, ChatSkillStatusEntry>> = {};
