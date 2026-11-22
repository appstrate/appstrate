// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";
import { citedSkillIds } from "./chat-skills.ts";

/** The conversation's pinned skills; `null`: the skills panel is not offered, so no skill is listed. */
const PinnedSkillsContext = createContext<readonly string[] | null>(null);

export const PinnedSkillsProvider = PinnedSkillsContext.Provider;

export const usePinnedSkills = () => useContext(PinnedSkillsContext);

/** The skills the composer's draft cites, live as chips are added and removed. */
export function useCitedSkills(): string[] {
  const draft = useAuiState((s) => s.composer.text);
  return useMemo(() => citedSkillIds(draft), [draft]);
}
