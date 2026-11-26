// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's ONE tools panel, as state: whether it is open, and at which level. The phone's "+"
 * and the desktop's settings button open the same panel (a `Popover`, which is a sheet from the
 * bottom below `md` on its own). The desktop's chips and the context indicator open it at the level
 * they are about.
 *
 * And what of the composer's settings departs from its default, decided once: the desktop draws
 * it as chips, the phone's panel names it.
 */

import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from "react";
import { canComposeInlineRuns } from "../capabilities.ts";
import { canResetSkills } from "./chat-skills.ts";
import { useContextAllSpacesEnabled } from "./context-all-spaces-store.ts";
import { useConversationScope } from "./conversation-scope.ts";
import { useInlineRunModelEnabled } from "./inline-run-model-store.ts";
import { usePackageAuthoringEnabled } from "./package-authoring-store.ts";
import { useChatHost } from "./runtime-context.ts";
import { selectedModel, useModelPicker } from "./model-picker.ts";
import type { MenuBack } from "@appstrate/ui/components/sheet-menu";
import { useConversationSkillsContext } from "./use-conversation-skills.ts";

/** Where the panel is: its rows, or one of the levels they open in their place. */
export type ComposerPanelLevel = "tools" | "skills" | "models" | "configuration" | "limit";

export interface ComposerPanelState {
  open: boolean;
  level: ComposerPanelLevel;
  /** Opens the panel at `level`. */
  openAt: (level: ComposerPanelLevel) => void;
  setLevel: (level: ComposerPanelLevel) => void;
  close: () => void;
}

const CLOSED: ComposerPanelState = {
  open: false,
  level: "tools",
  openAt: () => {},
  setLevel: () => {},
  close: () => {},
};

const ComposerPanelContext = createContext<ComposerPanelState>(CLOSED);

/** One per composer: its "+", its settings button, its chips and its context indicator share it. */
export function ComposerPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<ComposerPanelLevel>("tools");
  const value = useMemo<ComposerPanelState>(
    () => ({
      open,
      level,
      openAt: (next) => {
        setLevel(next);
        setOpen(true);
      },
      setLevel,
      close: () => setOpen(false),
    }),
    [open, level],
  );
  return createElement(ComposerPanelContext.Provider, { value }, children);
}

export const useComposerPanel = () => useContext(ComposerPanelContext);

/** A composer setting off its default, and the panel level that changes it. */
export type ComposerDeparture =
  "contextAllSpaces" | "creationOff" | "inlineRunModel" | "limit" | "skills";

export const DEPARTURE_LEVEL: Record<ComposerDeparture, ComposerPanelLevel> = {
  contextAllSpaces: "tools",
  creationOff: "tools",
  inlineRunModel: "models",
  limit: "tools",
  skills: "skills",
};

/**
 * The composer's settings that depart from their default, in the order the desktop's chips show
 * them.
 *
 * The space limit is counted whenever it is on, though a conversation started in a selected space
 * starts limited to it: it narrows where the agent acts, which nothing in a reply shows, so every
 * format says it — the desktop by its chip naming the space, the phone by its panel.
 */
export function useComposerDepartures(authorsPackages: boolean): readonly ComposerDeparture[] {
  const conversation = useConversationSkillsContext();
  const scope = useConversationScope();
  const creationMode = usePackageAuthoringEnabled();
  const inlineRunModel = useInlineRunModelEnabled();
  const offersInlineRunModel = useOffersInlineRunModel();
  const contextAllSpaces = useContextAllSpacesEnabled();
  const offersContextAllSpaces = useOffersContextAllSpaces();
  const departures: ComposerDeparture[] = [];
  if (authorsPackages && !creationMode) departures.push("creationOff");
  if (offersInlineRunModel && inlineRunModel) departures.push("inlineRunModel");
  if (scope.restricted) departures.push("limit");
  if (offersContextAllSpaces && contextAllSpaces) departures.push("contextAllSpaces");
  if (conversation !== null && canResetSkills(conversation.skills)) departures.push("skills");
  return departures;
}

/** The open level's name and its way back: the container draws them as its heading. */
export function useComposerPanelHeading(): { title: string; back?: MenuBack } {
  const { t } = useChatHost();
  const { level, setLevel } = useComposerPanel();
  const picker = useModelPicker();
  const up = (to: ComposerPanelLevel): MenuBack => ({
    label: t("common:btn.back"),
    onClick: () => setLevel(to),
  });
  if (level === "skills") return { title: t("skills.title"), back: up("tools") };
  if (level === "models") return { title: t("composer.model"), back: up("tools") };
  if (level === "limit") return { title: t("composer.limit.generic"), back: up("tools") };
  if (level === "configuration") {
    const active = picker ? selectedModel(picker.models, picker.selectedId) : undefined;
    return {
      title: active?.label ?? active?.modelId ?? t("composer.model"),
      back: up("models"),
    };
  }
  return { title: t("composer.tools") };
}

/**
 * The every-space context switch is offered: the conversation can act in more than one space. A
 * limited one acts in its origin alone, which its context always details.
 */
export function useOffersContextAllSpaces(): boolean {
  const { actingSpaceIds } = useChatHost();
  const scope = useConversationScope();
  return !scope.restricted && (actingSpaceIds?.length ?? 0) > 1;
}

/** The inline-run model switch is offered: composing an inline run needs creation mode too. */
export function useOffersInlineRunModel(): boolean {
  const { can } = useChatHost();
  return usePackageAuthoringEnabled() && canComposeInlineRuns(can);
}
