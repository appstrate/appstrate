// SPDX-License-Identifier: Apache-2.0

// Skill picker: local selection seeded once; one PUT at a time, reverted on failure.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { MAX_PINNED_SKILLS, type ChatSkillSelection } from "../skills.ts";
import { skillPickerRows, togglePinned } from "./chat-skills.ts";
import { useChatHost, type GetHeaders } from "./runtime-context.ts";
import { fetchSkills, putSessionSkills, spaceIdFromHeaders } from "./sessions.ts";

interface SkillsPickerProps {
  sessionId: string;
  getHeaders: GetHeaders | undefined;
  initialSelection: ChatSkillSelection;
}

export function SkillsPicker({ sessionId, getHeaders, initialSelection }: SkillsPickerProps) {
  const { t } = useChatHost();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(initialSelection);
  // Controls are disabled while a PUT is in flight, so writes never race.
  const [saving, setSaving] = useState(false);
  // Space-scoped: the listing reads `X-Space-Id`, so the key carries the space.
  const spaceId = spaceIdFromHeaders(getHeaders);
  const catalogue = useQuery({
    queryKey: ["chat", "skills", spaceId],
    queryFn: () => fetchSkills(getHeaders),
    enabled: !!spaceId,
    staleTime: 60_000,
  });
  const skills = catalogue.data ?? [];
  // A disabled query stays `isPending` forever; no space reads as "nothing".
  const loading = !!spaceId && catalogue.isPending;

  const pinned = selection.pinned;
  const pinnedSet = new Set(pinned);
  const atPinCap = pinned.length >= MAX_PINNED_SKILLS;
  const rows = skillPickerRows(skills, pinned);

  const apply = (next: ChatSkillSelection) => {
    const previous = selection;
    setSelection(next);
    setSaving(true);
    putSessionSkills(getHeaders, sessionId, next)
      .catch(() => setSelection(previous))
      .finally(() => setSaving(false));
  };

  const togglePin = (packageId: string) => {
    apply({ ...selection, pinned: togglePinned(pinned, packageId) });
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
                aria-label={
                  pinned.length > 0
                    ? t("skills.labelCount", { n: pinned.length })
                    : t("skills.label")
                }
                className={cn(
                  "relative size-8 shrink-0 rounded-lg",
                  pinned.length > 0 ? "text-primary hover:text-primary" : "text-muted-foreground",
                )}
              >
                <BookOpenIcon />
                {pinned.length > 0 && (
                  <span
                    aria-hidden="true"
                    className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-4 font-medium"
                  >
                    {pinned.length}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72 text-xs">
            <p className="font-medium">{t("skills.title")}</p>
            {pinned.length > 0 && (
              <p className="text-muted-foreground mt-0.5">
                {t("skills.pinned", { n: pinned.length })}
              </p>
            )}
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

        <div className="mt-2 flex shrink-0 items-start gap-2 px-1">
          <Checkbox
            id="skills-catalogue"
            data-testid="skills-catalogue-toggle"
            checked={selection.catalogue}
            disabled={saving}
            onCheckedChange={(checked) => apply({ ...selection, catalogue: checked === true })}
            className="mt-0.5"
          />
          <label htmlFor="skills-catalogue" className="min-w-0 cursor-pointer">
            <span className="block text-xs font-medium">{t("skills.catalogue.label")}</span>
            <span className="text-muted-foreground block text-[0.7rem] leading-snug">
              {t("skills.catalogue.hint")}
            </span>
          </label>
        </div>

        {atPinCap && (
          <p className="text-muted-foreground mt-2 shrink-0 px-1 text-[0.7rem] leading-snug">
            {t("skills.pinnedMax", { max: MAX_PINNED_SKILLS })}
          </p>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
          <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
            {t("skills.pinHeading")}
          </div>
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
              const checked = pinnedSet.has(skill.package_id);
              return (
                <div key={skill.package_id} className="flex items-start gap-2 rounded-md p-1">
                  <Checkbox
                    id={id}
                    data-testid={`skill-pin-${skill.package_id}`}
                    checked={checked}
                    disabled={saving || (!checked && atPinCap)}
                    onCheckedChange={() => togglePin(skill.package_id)}
                    className="mt-0.5 shrink-0"
                  />
                  <label
                    htmlFor={id}
                    className={cn(
                      "min-w-0 flex-1 cursor-pointer",
                      !checked && atPinCap && "opacity-50",
                    )}
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs font-medium">
                        {skill.display_name ?? skill.package_id}
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
