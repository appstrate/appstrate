// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's skill mode and chosen skills. Local selection
// seeded once; nothing is written here — the next turn carries it.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import {
  injectsSkills,
  MAX_PINNED_SKILLS,
  type ChatSkillMode,
  type ChatSkillSelection,
} from "../skills.ts";
import { skillPickerRows, togglePinned } from "./chat-skills.ts";
import { useChatHost, type GetHeaders } from "./runtime-context.ts";
import { fetchSkills, spaceIdFromHeaders } from "./sessions.ts";

/** Every mode in display order, with its copy; a `Record`, so a new mode must be added here. */
const MODE_COPY: Record<ChatSkillMode, { label: string; hint: string }> = {
  auto: { label: "skills.mode.auto.label", hint: "skills.mode.auto.hint" },
  manual: { label: "skills.mode.manual.label", hint: "skills.mode.manual.hint" },
  strict: { label: "skills.mode.strict.label", hint: "skills.mode.strict.hint" },
};
const MODES = Object.keys(MODE_COPY) as ChatSkillMode[];

interface SkillsPickerProps {
  getHeaders: GetHeaders | undefined;
  initialSelection: ChatSkillSelection;
  /** Every change, for the next turn to carry. */
  onChange: (selection: ChatSkillSelection) => void;
}

export function SkillsPicker({ getHeaders, initialSelection, onChange }: SkillsPickerProps) {
  const { t, can } = useChatHost();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(initialSelection);
  // Space-scoped: the listing reads `X-Space-Id`, so the key carries the space.
  const spaceId = spaceIdFromHeaders(getHeaders);
  const readable = !!spaceId && can("skills:read");
  const catalogue = useQuery({
    queryKey: ["chat", "skills", spaceId],
    queryFn: () => fetchSkills(getHeaders),
    enabled: readable,
    staleTime: 60_000,
  });
  const skills = catalogue.data ?? [];
  // A disabled query stays `isPending` forever; unreadable reads as "nothing".
  const loading = readable && catalogue.isPending;

  const pinned = selection.pinnedSkills;
  const pinnedSet = new Set(pinned);
  const atPinCap = pinned.length >= MAX_PINNED_SKILLS;
  const rows = skillPickerRows(skills, pinned);
  // `auto` keeps the chosen skills but does not use them: the list is inert.
  const choosing = injectsSkills(selection.skillMode);
  const inUse = choosing ? pinned.length : 0;

  const apply = (next: ChatSkillSelection) => {
    setSelection(next);
    onChange(next);
  };

  const togglePin = (packageId: string) => {
    apply({ ...selection, pinnedSkills: togglePinned(pinned, packageId) });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="skills-picker-trigger"
                // The badge count is painted; a screen reader gets it here.
                aria-label={inUse > 0 ? t("skills.labelCount", { n: inUse }) : t("skills.label")}
                className={cn(
                  "relative size-8 shrink-0 rounded-lg",
                  choosing ? "text-primary hover:text-primary" : "text-muted-foreground",
                )}
              >
                <BookOpenIcon />
                {inUse > 0 && (
                  <span
                    aria-hidden="true"
                    className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-4 font-medium"
                  >
                    {inUse}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72 text-xs">
            <p className="font-medium">{t("skills.title")}</p>
            <p className="text-muted-foreground mt-0.5">
              {t(MODE_COPY[selection.skillMode].label)}
              {inUse > 0 && ` · ${t("skills.chosen", { n: inUse })}`}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t("skills.title")}
        data-testid="skills-picker-popover"
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(23rem,calc(100vw-1.5rem))] flex-col p-3"
      >
        <p className="shrink-0 text-sm font-medium">{t("skills.title")}</p>

        {/* The model picker's control, for one look across the composer. */}
        <Tabs
          value={selection.skillMode}
          onValueChange={(mode) => {
            if (mode !== selection.skillMode) {
              apply({ ...selection, skillMode: mode as ChatSkillMode });
            }
          }}
          className="mt-2 shrink-0"
        >
          <TabsList aria-label={t("skills.modeLabel")} className="grid h-8 w-full grid-cols-3">
            {MODES.map((mode) => (
              <TabsTrigger
                key={mode}
                value={mode}
                data-testid={`skills-mode-${mode}`}
                className="h-6 px-2 text-xs"
              >
                {t(MODE_COPY[mode].label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-muted-foreground mt-1.5 shrink-0 px-1 text-[0.7rem] leading-snug">
          {t(MODE_COPY[selection.skillMode].hint)}
        </p>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
          <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
            {t("skills.chooseHeading")}
          </div>
          {!choosing ? (
            <p className="text-muted-foreground px-1 pb-1 text-[0.7rem] leading-snug">
              {t("skills.chooseInAuto")}
            </p>
          ) : (
            atPinCap && (
              <p className="text-muted-foreground px-1 pb-1 text-[0.7rem] leading-snug">
                {t("skills.chosenMax", { max: MAX_PINNED_SKILLS })}
              </p>
            )
          )}
          {loading ? (
            <p className="text-muted-foreground px-1 py-3 text-center text-xs">
              {t("skills.loading")}
            </p>
          ) : catalogue.isError ? (
            <p className="text-destructive px-1 py-3 text-center text-xs">{t("skills.error")}</p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground px-1 py-3 text-center text-xs">
              {t("skills.empty")}
            </p>
          ) : (
            rows.map(({ skill, available }, index) => {
              // By row: a package id's `@` and `/` break selectors, and a slug
              // of it can collide (`@a-b/c`, `@a/b-c`).
              const id = `skills-pin-${index}`;
              const checked = pinnedSet.has(skill.packageId);
              const inert = !choosing || (!checked && atPinCap);
              return (
                <div key={skill.packageId} className="flex items-start gap-2 rounded-md p-1">
                  <Checkbox
                    id={id}
                    data-testid={`skill-pin-${skill.packageId}`}
                    checked={checked}
                    disabled={inert}
                    onCheckedChange={() => togglePin(skill.packageId)}
                    className="mt-0.5 shrink-0"
                  />
                  <label
                    htmlFor={id}
                    className={cn("min-w-0 flex-1 cursor-pointer", inert && "opacity-50")}
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs font-medium">
                        {skill.display_name ?? skill.packageId}
                      </span>
                      {skill.version && (
                        <span className="text-muted-foreground shrink-0 text-[0.65rem]">
                          v{skill.version}
                        </span>
                      )}
                    </span>
                    {available ? (
                      skill.description && (
                        <span className="text-muted-foreground line-clamp-2 text-[0.7rem] leading-snug">
                          {skill.description}
                        </span>
                      )
                    ) : (
                      <span className="text-muted-foreground text-[0.7rem] leading-snug italic">
                        {t("skills.unavailable")}
                      </span>
                    )}
                  </label>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
