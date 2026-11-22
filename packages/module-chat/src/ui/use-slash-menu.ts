// SPDX-License-Identifier: Apache-2.0

/** The `/` menu's state for the composer's draft; the listbox it drives is `slash-menu.tsx`. */

import { createContext, useContext, useId, useMemo, useState, type KeyboardEvent } from "react";
import type { ChatSkillSelection } from "../skills.ts";
import type { AgentChip } from "./agent-prompt-part.ts";
import { useChatHost, useChatTransport } from "./runtime-context.ts";
import { slashChoice, slashEntries, slashKey, slashQuery, type SlashEntry } from "./slash-menu.ts";
import { useChatCommands } from "./use-chat-commands.ts";

/** The conversation's skill selection and how to change it, for the menu's `/skill` pins. */
export interface SkillSelectionControl {
  selection: ChatSkillSelection;
  onChange: (selection: ChatSkillSelection) => void;
}

/** `null`: the selection cannot be changed here (the skills panel is not offered): no skill is listed. */
const SkillSelectionContext = createContext<SkillSelectionControl | null>(null);

export const SkillSelectionProvider = SkillSelectionContext.Provider;

const NO_PINS: readonly string[] = [];

/** The DOM id of the option at `index`, which the input names as its active descendant. */
export const optionId = (listId: string, index: number) => `${listId}-${index}`;

/** The menu's state for the draft `text`: what it lists, which entry is active, what a key does. */
export function useSlashMenu({
  text,
  setText,
  running,
  setAgent,
}: {
  text: string;
  setText: (text: string) => void;
  running: boolean;
  setAgent: (agent: AgentChip) => void;
}) {
  const { can } = useChatHost();
  const transport = useChatTransport() ?? undefined;
  const skills = useContext(SkillSelectionContext);
  // Offered to a caller who may write the chat: the route's own guard.
  const query = can("chat:write") ? slashQuery(text) : null;
  const commands = useChatCommands(transport, query !== null);
  const pinned = skills?.selection.pinnedSkills ?? NO_PINS;
  const canPin = skills !== null;
  const data = commands.data;
  const entries = useMemo(
    () => (query === null || !data ? [] : slashEntries(data, query, { pinned, running, canPin })),
    [data, query, pinned, running, canPin],
  );
  // Escape closes the menu for the draft it was pressed on; typing on reopens it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const listId = useId();
  const open = entries.length > 0 && text !== dismissed;
  const active =
    query !== null && cursor.query === query ? Math.min(cursor.index, entries.length - 1) : 0;

  const choose = (entry: SlashEntry) => {
    const choice = slashChoice(entry, pinned);
    // A full selection refuses the pin and keeps the draft.
    if (choice.kind === "refuse") return;
    if (choice.kind === "pin")
      skills?.onChange({ ...skills.selection, pinnedSkills: choice.pinned });
    if (choice.kind === "agent") setAgent(choice.agent);
    setText("");
  };

  /** Whether the menu took the key: the composer then leaves it alone (Enter does not send). */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    const result = slashKey(event.key, active, entries.length);
    if (!result) return false;
    event.preventDefault();
    if (result.action === "select") choose(entries[active]!);
    else if (result.action === "close") setDismissed(text);
    else if (query !== null) setCursor({ query, index: result.active });
    return true;
  };

  return {
    open,
    entries,
    active,
    listId,
    onKeyDown,
    onChoose: (index: number) => choose(entries[index]!),
    onHover: (index: number) => {
      if (query !== null && index !== active) setCursor({ query, index });
    },
    /** For the input while the menu is open. */
    inputProps: open
      ? ({
          "aria-haspopup": "listbox",
          "aria-controls": listId,
          "aria-activedescendant": optionId(listId, active),
        } as const)
      : {},
  };
}
