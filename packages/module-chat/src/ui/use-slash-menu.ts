// SPDX-License-Identifier: Apache-2.0

/** The `/` menu's state for the composer's draft; the listbox it drives is `slash-menu.tsx`. */

import { createContext, useContext, useId, useMemo, useState, type KeyboardEvent } from "react";
import type { ChatSkillSelection } from "../skills.ts";
import type { AgentChip } from "./agent-prompt-part.ts";
import { useChatHost, useChatTransport } from "./runtime-context.ts";
import {
  dismissalFor,
  isComposingKey,
  parseTypedCommand,
  slashChoice,
  slashEntries,
  slashKey,
  slashQuery,
  type SlashChoice,
  type SlashEntry,
} from "./slash-menu.ts";
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

/** What the menu shows: its entries, or why there are none yet. */
export type SlashStatus = "ready" | "loading" | "error";

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
  const writes = can("chat:write");
  // Offered to a caller who may write the chat: the route's own guard.
  const query = writes ? slashQuery(text) : null;
  // Read from the first `/`, so a command typed in one go (`/name text`) finds its entry too.
  const commands = useChatCommands(transport, writes && text.startsWith("/"));
  const pinned = skills?.selection.pinnedSkills ?? NO_PINS;
  const canPin = skills !== null;
  const data = commands.data;
  const context = useMemo(() => ({ pinned, running, canPin }), [pinned, running, canPin]);
  const entries = useMemo(
    () => (query === null || !data ? [] : slashEntries(data, query, context)),
    [data, query, context],
  );
  const typed = useMemo(
    () => (writes && data && !running ? parseTypedCommand(text, data, context) : null),
    [writes, data, running, text, context],
  );
  // Escape closes the menu for the draft it was pressed on; any other text forgets it, so
  // typing `/` again reopens it.
  const [dismissedState, setDismissed] = useState<string | null>(null);
  const dismissed = dismissalFor(dismissedState, text);
  if (dismissed !== dismissedState) setDismissed(dismissed);
  const [refusedFor, setRefusedFor] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const listId = useId();
  const status: SlashStatus =
    query === null ? "ready" : commands.isError ? "error" : data ? "ready" : "loading";
  const open = text !== dismissed && (entries.length > 0 || (query !== null && status !== "ready"));
  const active =
    query !== null && cursor.query === query ? Math.min(cursor.index, entries.length - 1) : 0;

  /** Applies a choice and leaves `rest` as the draft; a full selection refuses and keeps it all. */
  const choose = (entry: SlashEntry, rest = ""): SlashChoice => {
    const choice = slashChoice(entry, pinned);
    if (choice.kind === "refuse") {
      setRefusedFor(text);
      return choice;
    }
    if (choice.kind === "pin")
      skills?.onChange({ ...skills.selection, pinnedSkills: choice.pinned });
    if (choice.kind === "agent") setAgent(choice.agent);
    setText(rest);
    return choice;
  };

  /** Whether the menu took the key: the composer then leaves it alone (Enter does not send). */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || isComposingKey(event)) return false;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (entries.length === 0) {
      // Nothing to pick yet: a draft that is only a `/token` is kept, not sent, while it loads.
      const waiting = status === "loading" && (event.key === "Enter" || event.key === "Tab");
      if (!waiting && event.key !== "Escape") return false;
      event.preventDefault();
      if (event.key === "Escape") setDismissed(text);
      return true;
    }
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
    status,
    entries,
    active,
    listId,
    /** The pin was refused at the cap for this very draft: announced, not silent. */
    refused: refusedFor === text,
    /** The draft as a command typed in one go, when it is exactly one. */
    typed,
    choose,
    onKeyDown,
    onChoose: (index: number) => choose(entries[index]!),
    onHover: (index: number) => {
      if (query !== null && index !== active) setCursor({ query, index });
    },
    /** For the input while the menu is open. */
    inputProps: open
      ? ({
          role: "combobox",
          "aria-expanded": true,
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          "aria-controls": listId,
          ...(entries.length > 0 && { "aria-activedescendant": optionId(listId, active) }),
        } as const)
      : {},
  };
}
