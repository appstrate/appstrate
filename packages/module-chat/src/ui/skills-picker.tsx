// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's skill mode and chosen skills. Controlled;
// nothing is written here — the next turn carries the selection.

import type { ChatSkillMode } from "@appstrate/db/schema";
import type { ReactNode } from "react";
import { BookOpenIcon } from "lucide-react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { Popover, PopoverAnchor, PopoverContent } from "@appstrate/ui/components/popover";
import { cn } from "@appstrate/ui/cn";
import { injectsSkills, MAX_PINNED_SKILLS, type ChatSkillSelection } from "../skills.ts";
import { skillPickerRows, togglePinned } from "./chat-skills.ts";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";

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
  /** Opened from the composer's settings menu or a skills chip, never by a trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The popover anchors to this: the composer's tools row. */
  children: ReactNode;
}

/**
 * The entry to the picker in the composer's tool row while no skill is loaded (drawn by
 * `SkillChips`): drawn only off the automatic mode, it reopens the picker, and its X returns to
 * the automatic mode (the chosen skills are kept, unused, as the mode switch keeps them).
 */
export function SkillsChip({
  selection,
  onClick,
  onReset,
}: {
  selection: ChatSkillSelection;
  onClick: () => void;
  onReset: () => void;
}) {
  const { t } = useChatHost();
  if (!injectsSkills(selection.skillMode)) return null;
  return (
    <RemovableChip
      icon={<BookOpenIcon />}
      open={{ onClick, label: t("skills.label"), testId: "skills-picker-trigger" }}
      removeLabel={t("skills.resetToAuto")}
      onRemove={onReset}
      className="shrink-0"
    >
      {t("skills.label")}
    </RemovableChip>
  );
}

/** The popover's body: the mode switch and the lists. Exported to be rendered without the popover's portal. */
export function SkillsPickerPanel({
  transport,
  selection,
  onChange,
}: Pick<SkillsPickerProps, "transport" | "selection" | "onChange">) {
  const { t } = useChatHost();
  const catalogue = useSkillCatalogue(transport, true);
  const skills = catalogue.data ?? [];
  // `isLoading`, not `isPending`: a disabled query stays pending forever, and unreadable reads
  // as "nothing".
  const loading = catalogue.isLoading;

  const pinned = selection.pinnedSkills;
  const pinnedSet = new Set(pinned);
  const atPinCap = pinned.length >= MAX_PINNED_SKILLS;
  const rows = skillPickerRows(skills, pinned);
  // `auto` keeps the chosen skills but uses none: no list is offered then.
  const choosing = injectsSkills(selection.skillMode);

  const togglePin = (packageId: string) => {
    onChange({ ...selection, pinnedSkills: togglePinned(pinned, packageId) });
  };

  return (
    <>
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
        {!choosing ? (
          // Automatic: the assistant picks among the space's skills itself, so none is listed
          // to choose from.
          <p className="text-muted-foreground px-1 py-1 text-[0.7rem] leading-snug">
            {t("skills.chooseInAuto")}
          </p>
        ) : (
          <>
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
              <p className="text-muted-foreground px-1 py-3 text-center text-xs">
                {t("skills.empty")}
              </p>
            ) : (
              rows.map(({ skill, available }, index) => {
                // By row: a package id's `@` and `/` break selectors, and a slug
                // of it can collide (`@a-b/c`, `@a/b-c`).
                const id = `skills-pin-${index}`;
                const checked = pinnedSet.has(skill.packageId);
                const inert = !checked && atPinCap;
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
          </>
        )}
      </div>
    </>
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
        <SkillsPickerPanel transport={transport} selection={selection} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
