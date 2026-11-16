// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's skill mode and chosen skills. Controlled;
// nothing is written here — the next turn carries the selection. The skills the
// space imposes are listed first, locked: no selection removes them.

import type { ChatSkillMode } from "@appstrate/db/schema";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BookOpenIcon } from "lucide-react";
import { Badge, badgeVariants } from "@appstrate/ui/components/badge";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Popover, PopoverAnchor, PopoverContent } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import {
  DEFAULT_SKILL_SELECTION,
  injectsSkills,
  MAX_PINNED_SKILLS,
  type ChatSkillSelection,
} from "../skills.ts";
import {
  fetchSkills,
  ownPins,
  pinCapReached,
  skillPickerRows,
  togglePinned,
} from "./chat-skills.ts";
import { useEnforcedSkills } from "./use-enforced-skills.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { chatScopeKey } from "./scope.ts";

/** Every mode in display order, with its copy; a `Record`, so a new mode must be added here. */
const MODE_COPY: Record<ChatSkillMode, { label: string; hint: string }> = {
  auto: { label: "skills.mode.auto.label", hint: "skills.mode.auto.hint" },
  manual: { label: "skills.mode.manual.label", hint: "skills.mode.manual.hint" },
  strict: { label: "skills.mode.strict.label", hint: "skills.mode.strict.hint" },
};
const MODES = Object.keys(MODE_COPY) as ChatSkillMode[];

interface SkillsPickerProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onChange: (selection: ChatSkillSelection) => void;
  /** Opened from the composer's "+" menu or the chip, never by a trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The popover anchors to this: the composer's tools row. */
  children: ReactNode;
}

/** Skills in use this turn (the space's imposed ones + the chosen ones), as the old trigger badge counted. */
function useSkillsInUse(transport: ChatTransport | undefined, selection: ChatSkillSelection) {
  const enforcedQuery = useEnforcedSkills(transport);
  const enforcedIds = new Set((enforcedQuery.data ?? []).map((skill) => skill.packageId));
  const pinned = ownPins(selection.pinnedSkills, enforcedIds);
  const inUse =
    (enforcedQuery.data?.length ?? 0) + (injectsSkills(selection.skillMode) ? pinned.length : 0);
  return { inUse, loading: enforcedQuery.isLoading };
}

/**
 * The composer chip for a non-default skill selection; it reopens the picker.
 * Its count hangs on the enforced read: a skeleton holds the slot meanwhile,
 * not a chip in its default look.
 */
export function SkillsChip({
  transport,
  selection,
  onClick,
}: {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onClick: () => void;
}) {
  const { t } = useChatHost();
  const { inUse, loading } = useSkillsInUse(transport, selection);
  const isDefault =
    selection.skillMode === DEFAULT_SKILL_SELECTION.skillMode &&
    selection.pinnedSkills.length === 0;
  if (isDefault) return null;
  if (loading) return <Skeleton className="h-7 w-24 rounded-full" />;
  return (
    <button
      type="button"
      data-testid="skills-picker-trigger"
      aria-label={inUse > 0 ? t("skills.labelCount", { n: inUse }) : t("skills.label")}
      onClick={onClick}
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "text-muted-foreground h-7 shrink-0 gap-1.5 px-2.5 py-0 font-normal",
      )}
    >
      <BookOpenIcon className="size-3.5" />
      <span>{inUse > 0 ? t("skills.chip", { n: inUse }) : t("skills.label")}</span>
    </button>
  );
}

export function SkillsPicker({
  transport,
  selection,
  onChange,
  open,
  onOpenChange,
  children,
}: SkillsPickerProps) {
  const { t, can } = useChatHost();
  const scopeKey = chatScopeKey(transport);
  const readable = !!scopeKey && !!transport && can("skills:read");
  const catalogue = useQuery({
    // Under the shell's `["packages","skills"]` prefix, so its invalidations on a
    // skill change reach this entry; `consumer` keeps it a separate cache entry
    // (a different projection of the same route), and the scope (a space, or the organization) keys it.
    queryKey: ["packages", "skills", { consumer: "chat" }, scopeKey],
    queryFn: () => fetchSkills(transport!),
    enabled: readable,
    staleTime: 60_000,
  });
  const skills = catalogue.data ?? [];
  const enforcedQuery = useEnforcedSkills(transport);
  const enforced = enforcedQuery.data ?? [];
  const enforcedIds = new Set(enforced.map((skill) => skill.packageId));
  // A disabled query stays `isPending` forever; unreadable reads as "nothing".
  // Waiting on the enforced read too keeps an imposed skill from flashing as choosable.
  const loading = (readable && catalogue.isPending) || (!!scopeKey && enforcedQuery.isPending);

  const pinned = ownPins(selection.pinnedSkills, enforcedIds);
  const pinnedSet = new Set(pinned);
  const atPinCap = pinCapReached(selection.pinnedSkills, enforcedIds);
  const rows = skillPickerRows(skills, pinned, enforcedIds);
  // `auto` keeps the chosen skills but does not use them: the list is inert.
  const choosing = injectsSkills(selection.skillMode);

  const togglePin = (packageId: string) => {
    onChange({ ...selection, pinnedSkills: togglePinned(pinned, packageId) });
  };

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
        <p className="shrink-0 text-sm font-medium">{t("skills.title")}</p>

        {/* The model picker's control, for one look across the composer. */}
        <Tabs
          value={selection.skillMode}
          onValueChange={(mode) => {
            if (mode !== selection.skillMode) {
              onChange({ ...selection, skillMode: mode as ChatSkillMode });
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
          {enforced.map((skill) => (
            <div key={skill.packageId} className="flex items-start gap-2 rounded-md p-1">
              <Checkbox
                data-testid={`skill-enforced-${skill.packageId}`}
                checked
                disabled
                aria-label={skill.display_name ?? skill.packageId}
                className="mt-0.5 shrink-0"
              />
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-1.5">
                <span className="truncate text-xs font-medium">
                  {skill.display_name ?? skill.packageId}
                </span>
                {skill.version && (
                  <span className="text-muted-foreground shrink-0 text-[0.65rem]">
                    v{skill.version}
                  </span>
                )}
                <Badge variant="secondary" className="px-1.5 py-0 text-[0.6rem]">
                  {t("skills.enforcedBadge")}
                </Badge>
              </span>
            </div>
          ))}
          {enforcedQuery.isError && (
            <p className="text-destructive px-1 pb-1 text-[0.7rem] leading-snug">
              {t("skills.enforcedError")}
            </p>
          )}
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
            <p className="text-muted-foreground px-1 py-3 text-center text-xs">
              {t(enforced.length > 0 ? "skills.emptyBesidesEnforced" : "skills.empty")}
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
