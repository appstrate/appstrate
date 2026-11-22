// SPDX-License-Identifier: Apache-2.0

import type { TurnScope, TurnSkillWrite } from "../src/resumable.ts";
import { DEFAULT_SKILL_SELECTION } from "../src/skills.ts";

/** The scope of a session created with no origin space, no limit and the default skills. */
export const UNLIMITED_SCOPE: TurnScope = {
  spaceId: null,
  restricted: false,
  ...DEFAULT_SKILL_SELECTION,
};

/** A claim that changes no skill and writes no verdict. */
export const NO_SKILL_WRITE: TurnSkillWrite = { changes: { pin: [], unpin: [] }, status: {} };
