// SPDX-License-Identifier: Apache-2.0

// Skill picker: the conversation's skills and the discovery switch. Controlled: a change goes to
// the conversation's state (a PATCH once the server holds the row). Each pinned row is loaded,
// or not loaded with the server's reason; only the server says a skill is loaded.

import { useId } from "react";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Progress } from "@appstrate/ui/components/progress";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Switch } from "@appstrate/ui/components/switch";
import { cn } from "@appstrate/ui/cn";
import {
  exceedsBudget,
  pinIds,
  skillBudget,
  skillPickerRows,
  skillRowState,
  type EffectiveSkills,
  type SkillBudget,
} from "./chat-skills.ts";
import type { ConversationSkillsState } from "./use-conversation-skills.ts";
import { useChatCommands } from "./use-chat-commands.ts";
import { useChatHost } from "./runtime-context.ts";

interface SkillsPickerProps {
  conversation: Pick<ConversationSkillsState, "skills" | "setPin" | "setDiscovery">;
  /** The skills the composer's draft cites: counted in the budget, never checked here. */
  draft: EffectiveSkills;
}

const NOTE_CLASS = "text-muted-foreground px-1 text-[0.7rem] leading-snug";

/** The pins' share of the budget, as text and a bar; warned once it is past the limit. */
function BudgetGauge({ budget }: { budget: SkillBudget }) {
  const { t, lang } = useChatHost();
  const format = new Intl.NumberFormat(lang);
  const over = budget.used > budget.max;
  return (
    <div data-testid="skills-budget" data-over={over || undefined} className="mt-2 px-1">
      <div className="flex items-baseline justify-between gap-2 text-[0.7rem]">
        <span className="text-muted-foreground">{t("skills.budget.label")}</span>
        <span className={cn("tabular-nums", over && "text-warning")}>
          {t("skills.budget.counts", {
            used: format.format(budget.used),
            max: format.format(budget.max),
          })}
        </span>
      </div>
      <Progress
        aria-hidden
        value={Math.min(budget.used, budget.max)}
        max={budget.max}
        className="mt-1 h-1.5"
        indicatorClassName={over ? "bg-warning" : undefined}
      />
      {over && (
        <p className="text-warning mt-1 text-[0.7rem] leading-snug">{t("skills.budget.over")}</p>
      )}
    </div>
  );
}

/** The tools panel's skills level: the discovery switch and the skill list. */
export function SkillsPickerPanel({
  conversation: { skills: stored, setPin, setDiscovery },
  draft: effective,
}: SkillsPickerProps) {
  const { t } = useChatHost();
  const baseId = useId();
  const discoveryId = `${baseId}-discovery`;
  const catalogue = useChatCommands(true);
  const skills = catalogue.data?.skills ?? [];
  // `isLoading`, not `isPending`: a disabled query stays pending forever, and unreadable reads
  // as "nothing".
  const loading = catalogue.isLoading;

  const rows = skillPickerRows(skills, pinIds(stored));
  const budget = skillBudget(stored, effective, skills);
  const someLoaded = stored.pins.some((pin) => pin.status === "injected");
  const somePending = stored.pins.some((pin) => pin.status === null);

  /** An unpinned skill whose listed size would take the budget past its limit (a cited one is counted). */
  const overBudgetOf = (skill: { id: string; bytes: number | null }, checked: boolean) =>
    !checked && !effective.cited.has(skill.id) && exceedsBudget(budget, skill.bytes);

  const togglePin = (skill: { id: string; bytes: number | null }, checked: boolean) => {
    if (overBudgetOf(skill, checked)) return;
    setPin(skill.id, !checked);
  };

  return (
    <>
      <div className="mt-2 flex shrink-0 items-center justify-between gap-3 px-1">
        <label htmlFor={discoveryId} className="cursor-pointer text-xs font-medium">
          {t("skills.discovery.label")}
        </label>
        <Switch
          id={discoveryId}
          data-testid="skills-discovery"
          checked={stored.skillDiscovery}
          onCheckedChange={setDiscovery}
        />
      </div>
      <p className={cn(NOTE_CLASS, "mt-1.5 shrink-0")}>
        {t(stored.skillDiscovery ? "skills.discovery.hintOn" : "skills.discovery.hintOff")}
      </p>

      <BudgetGauge budget={budget} />

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t pt-2">
        <div className="text-muted-foreground px-1 py-1 text-[0.65rem] font-semibold tracking-wider uppercase">
          {t("skills.chooseHeading")}
        </div>
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
            const id = `${baseId}-pin-${index}`;
            const nameId = `${id}-name`;
            const detailsId = `${id}-details`;
            const state = skillRowState(stored, skill.id);
            const checked = state.kind !== "off";
            // Not `disabled`: a locked row stays focusable, so its reason is still read out.
            const inert = overBudgetOf(skill, checked);
            const refused = state.kind === "refused";
            return (
              <div key={skill.id} className="flex items-start gap-2 rounded-md p-1">
                <Checkbox
                  id={id}
                  data-testid={`skill-pin-${skill.id}`}
                  data-state-kind={state.kind}
                  checked={checked}
                  aria-disabled={inert || undefined}
                  aria-labelledby={nameId}
                  aria-describedby={detailsId}
                  onCheckedChange={() => togglePin(skill, checked)}
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
                    {refused && (
                      <span
                        data-testid={`skill-pin-state-${skill.id}`}
                        className={cn(
                          "block text-[0.7rem] leading-snug",
                          refused ? "text-warning" : "text-muted-foreground",
                        )}
                      >
                        {t(`skills.state.refused.${state.reason}`)}
                      </span>
                    )}
                    {inert && (
                      <span
                        data-testid={`skill-pin-budget-${skill.id}`}
                        className="text-warning block text-[0.7rem] leading-snug"
                      >
                        {t("skills.budget.wouldExceed")}
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
      {(someLoaded || somePending) && (
        <div className="shrink-0 border-t pt-2">
          {someLoaded && (
            <p data-testid="skills-uncheck-hint" className={NOTE_CLASS}>
              {t("skills.uncheckHint")}
            </p>
          )}
          {somePending && (
            <p data-testid="skills-pending-note" className={NOTE_CLASS}>
              {t("skills.pendingNote")}
            </p>
          )}
        </div>
      )}
    </>
  );
}
