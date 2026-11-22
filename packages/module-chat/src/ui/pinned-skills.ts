// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

/** The conversation's pinned skills; `null`: the skills panel is not offered, so no skill is listed. */
const PinnedSkillsContext = createContext<readonly string[] | null>(null);

export const PinnedSkillsProvider = PinnedSkillsContext.Provider;

export const usePinnedSkills = () => useContext(PinnedSkillsContext);
