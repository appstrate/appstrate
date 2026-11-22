// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's skills and the discovery switch. Controlled; nothing is
// written here — the next turn carries the changes. Each row says what the server reported of
// its skill: only the server says a skill is loaded.

import type { ReactNode } from "react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import { Popover, PopoverAnchor, PopoverContent } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import {
  effectiveSkills,
  skillPickerRows,
  skillRowState,
  type ConversationSkills,
  type SkillRowState,
} from "./chat-skills.ts";
import type { SkillActions } from "./use-conversation-skills.ts";
import { useChatCommands } from "./use-chat-commands.ts";
import { useChatHost, type ChatTransport, type ChatTranslate } from "./runtime-context.ts";

interface SkillsPickerProps {
  transport: ChatTransport | undefined;
  skills: ConversationSkills;
  actions: Pick<SkillActions, "setPin" | "setDiscovery">;
  /** Opened from the composer's settings menu or a skills chip, never by a trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skills the composer's draft cites: checked here, and held by the message, not the panel. */
  cited: readonly string[];
  /** The popover anchors to this: the composer's tools row. */
  children: ReactNode;
}

const REFUSAL_KEY: Record<Extract<SkillRowState, { kind: "refused" }>["reason"], string> = {
  over_budget: "skills.state.refused.over_budget",
  unavailable: "skills.state.refused.unavailable",
  unreadable: "skills.state.refused.unreadable",
};

/** A row's caption: what the server reported of its skill; none for a skill the user's pin loaded. */
function rowCaption(state: SkillRowState, t: ChatTranslate): string | null {
  switch (state.kind) {
    case "cited":
      return t("skills.cited");
    case "next":
      return t("skills.state.next");
    case "loaded":
      return state.source === "assistant" ? t("skills.state.assistant") : null;
    case "refused":
      return t(REFUSAL_KEY[state.reason]);
    case "off":
      return null;
  }
}

/** The popover's body: the discovery switch and the skill list. Exported to be rendered without the popover's portal. */
export function SkillsPickerPanel({
  transport,
  skills: conversation,
  actions,
  cited,
}: Pick<SkillsPickerProps, "transport" | "skills" | "actions" | "cited">) {
  const { t } = useChatHost();
  const catalogue = useChatCommands(transport, true);
  const skills = catalogue.data?.skills ?? [];
  // `isLoading`, not `isPending`: a disabled query stays pending forever, and unreadable reads
  // as "nothing".
  const loading = catalogue.isLoading;

  const effective = effectiveSkills(conversation.pinned, cited);
  const atPinCap = effective.atCap;
  const rows = skillPickerRows(skills, effective.ids);

  const togglePin = (packageId: string, checked: boolean) => {
    // A cited skill is the message's: only removing its chip drops it. Past the cap, nothing pins.
    if (effective.cited.has(packageId) || (!checked && atPinCap)) return;
    actions.setPin(packageId, !checked);
  };

  return (
    <>
      <p className="shrink-0 text-sm font-medium">{t("skills.title")}</p>

      <div className="mt-2 flex shrink-0 items-center justify-between gap-3 px-1">
        <label htmlFor="skills-discovery" className="cursor-pointer text-xs font-medium">
          {t("skills.discovery.label")}
        </label>
        <Switch
          id="skills-discovery"
          data-testid="skills-discovery"
          checked={conversation.skillDiscovery}
          onCheckedChange={actions.setDiscovery}
        />
      </div>
      <p className="text-muted-foreground mt-1.5 shrink-0 px-1 text-[0.7rem] leading-snug">
        {t(conversation.skillDiscovery ? "skills.discovery.hintOn" : "skills.discovery.hintOff")}
      </p>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
        <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
          {t("skills.chooseHeading")}
        </div>
        {atPinCap && (
          <p className="text-muted-foreground px-1 pb-1 text-[0.7rem] leading-snug">
            {t("skills.chosenMax", { max: MAX_PINNED_SKILLS })}
          </p>
        )}
        {loading ? (
          <div role="status" aria-busy="true" aria-label={t("skills.loading")}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-2 rounded-md p-1">
                <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
                <Skeleton className="mt-1 h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : catalogue.isError ? (
          <p className="text-destructive px-1 py-3 text-center text-xs">{t("skills.error")}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-1 py-3 text-center text-xs">{t("skills.empty")}</p>
        ) : (
          rows.map(({ skill, available }, index) => {
            // By row: a package id's `@` and `/` break selectors, and a slug
            // of it can collide (`@a-b/c`, `@a/b-c`).
            const id = `skills-pin-${index}`;
            const nameId = `${id}-name`;
            const detailsId = `${id}-details`;
            const state = skillRowState(conversation, skill.id, effective.cited);
            const checked = state.kind !== "off";
            const isCited = state.kind === "cited";
            // Not `disabled`: a locked row stays focusable, so its reason is still read out.
            const inert = (!checked && atPinCap) || isCited;
            const caption = rowCaption(state, t);
            const refused = state.kind === "refused";
            const hasDetails = !!caption || (available ? !!skill.description : !refused);
            return (
              <div key={skill.id} className="flex items-start gap-2 rounded-md p-1">
                <Checkbox
                  id={id}
                  data-testid={`skill-pin-${skill.id}`}
                  data-state-kind={state.kind}
                  checked={checked}
                  aria-disabled={inert || undefined}
                  aria-labelledby={nameId}
                  aria-describedby={hasDetails ? detailsId : undefined}
                  data-cited={isCited || undefined}
                  onCheckedChange={() => togglePin(skill.id, checked)}
                  className={cn("mt-0.5 shrink-0", inert && "cursor-not-allowed opacity-50")}
                />
                <label
                  htmlFor={id}
                  className={cn("min-w-0 flex-1 cursor-pointer", inert && "opacity-50")}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span id={nameId} className="truncate text-xs font-medium">
                      {skill.name}
                    </span>
                    {skill.version && (
                      <span className="text-muted-foreground shrink-0 text-[0.65rem]">
                        v{skill.version}
                      </span>
                    )}
                  </span>
                  {/* The checkbox's description: why it is locked or not loaded, then what it does. */}
                  <span id={detailsId} className="block">
                    {caption && (
                      <span
                        data-testid={`skill-pin-state-${skill.id}`}
                        className={cn(
                          "block text-[0.7rem] leading-snug",
                          refused ? "text-warning" : "text-muted-foreground",
                        )}
                      >
                        {caption}
                      </span>
                    )}
                    {available && skill.description && (
                      <span className="text-muted-foreground line-clamp-2 text-[0.7rem] leading-snug">
                        {skill.description}
                      </span>
                    )}
                    {/* A pin the catalogue no longer lists; a refusal already says why it is out. */}
                    {!available && !refused && (
                      <span className="text-muted-foreground text-[0.7rem] leading-snug italic">
                        {t("skills.unavailable")}
                      </span>
                    )}
                  </span>
                </label>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export function SkillsPicker({
  transport,
  skills,
  actions,
  open,
  onOpenChange,
  cited,
  children,
}: SkillsPickerProps) {
  const { t } = useChatHost();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("skills.title")}
        data-testid="skills-picker-popover"
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(23rem,calc(100vw-1.5rem))] flex-col p-3"
      >
        <SkillsPickerPanel transport={transport} skills={skills} actions={actions} cited={cited} />
      </PopoverContent>
    </Popover>
  );
}
