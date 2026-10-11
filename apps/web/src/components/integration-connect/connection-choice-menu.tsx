// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Ban, Check, ChevronDown, Users, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { toggleCapped, type ConnectionSet } from "../../lib/connection-set";
import { AMBER_TEXT } from "./connection-picker-states";
import type { SetOption } from "./connection-set-option";

const NONE: readonly string[] = [];

/** The three exclusive ways to answer « which connections? », in the order the menu lists them. */
type ChoiceMode = "inherit" | "choose" | "none";

/** One connection of the list: its name, and the lines that tell it apart from the others. */
export interface ChoiceRow {
  id: string;
  name: ReactNode;
  description?: ReactNode;
  /** Lines under the description (what it grants, what it lacks). */
  extra?: ReactNode;
  /** Greys the name only: the reason stays legible. */
  muted?: boolean;
  /** Refuses a tick; a ticked one can still be unticked. */
  disabled?: boolean;
  /** A control on the row's end (renew). */
  trailing?: ReactNode;
}

/** One choice of the menu: its label, and one line saying what it means. */
function ChoiceLabel({ label, description }: { label: string; description: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground text-[0.65rem] break-words">{description}</span>
    </div>
  );
}

/** The radio of a mode: a menu item stands for it, the circle is a glyph. */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
        checked ? "border-foreground" : "border-muted-foreground/50"
      }`}
    >
      {checked && <span className="bg-foreground size-2 rounded-full" />}
    </span>
  );
}

export interface ConnectionChoiceMenuProps {
  /** Test ids read `<prefix>-<part>-<key>`; the agent's own keep `member-pick`. */
  testPrefix: string;
  testKey: string;
  /** Heading of the menu. */
  title?: string;
  trigger: { label: ReactNode; icon: LucideIcon; warn?: boolean };
  /** The trigger of a table cell is small; a form field's matches a `Select`. */
  compact?: boolean;
  /** The mode the stored value stands for; `null` when nothing is decided yet. */
  storedMode: ChoiceMode | null;
  /** « Hériter », absent where inheriting is no answer (what the server would take is no choice). */
  inherit?: { description: ReactNode };
  /** « Aucune connexion », absent for an integration that is required. */
  none?: { description: ReactNode };
  rows: readonly ChoiceRow[];
  /** What is ticked, the draft included. */
  checkedIds: readonly string[];
  /** Stored members no longer offered: listed unticked, so the next write visibly drops them. */
  unavailableIds?: readonly string[];
  unavailableRow: { label: string; hint?: string };
  /** Waits for a write in flight. */
  busy?: boolean;
  /** Ticks a connection (or unticks it): the caller writes it at once, or holds it as a draft. */
  onToggle: (id: string) => void;
  onInherit: () => void;
  onNone: () => void;
  /** « Valider », for a caller that holds the ticks as a draft; shown while something is ticked. */
  apply?: { enabled: boolean; onApply: () => void };
  /** Entries after the choices (add a connection, manage them). */
  footer?: ReactNode;
  /** The caller holds the open state when something outside the menu reopens it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The one component that chooses connections: a trigger that reads the current choice like a
 * select, and a menu in three exclusive modes (« Hériter », « Choisir des connexions » with the
 * connections as boxes under it, « Aucune connexion »). A mode the usage cannot answer is
 * left out, and a menu left with the list alone shows the list without its radio.
 */
export function ConnectionChoiceMenu({
  testPrefix,
  testKey,
  title,
  trigger,
  compact = false,
  storedMode,
  inherit,
  none,
  rows,
  checkedIds,
  unavailableIds = NONE,
  unavailableRow,
  busy = false,
  onToggle,
  onInherit,
  onNone,
  apply,
  footer,
  open: controlledOpen,
  onOpenChange: onControlledOpenChange,
}: ConnectionChoiceMenuProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const [ownOpen, setOwnOpen] = useState(false);
  // « Choisir » picked before any tick: the mode is on, the boxes are what is left to do.
  const [choosing, setChoosing] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const onOpenChange = (next: boolean) => {
    setOwnOpen(next);
    if (!next) setChoosing(false);
    onControlledOpenChange?.(next);
  };

  const hasList = rows.length > 0 || unavailableIds.length > 0;
  const modeCount = (inherit ? 1 : 0) + (none ? 1 : 0) + (hasList ? 1 : 0);
  // The radios only tell modes apart: with the list alone there is nothing to tell apart.
  const showModes = modeCount > 1 || (!hasList && modeCount === 1);
  const ticking = checkedIds.length > 0;
  // Ticking a connection is choosing: the mode follows the boxes.
  const shown: ChoiceMode | null = ticking || choosing ? "choose" : storedMode;
  const atCap = checkedIds.length >= MAX_CONNECTIONS_PER_INTEGRATION;
  const modeRow = (checked: boolean) => ({
    role: "menuitemradio" as const,
    "aria-checked": checked,
  });
  const TriggerIcon = trigger.icon;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={compact ? "sm" : "default"}
          className={
            compact
              ? `h-7 justify-start gap-1.5 text-xs ${trigger.warn ? AMBER_TEXT : ""}`
              : `w-full justify-start gap-2 font-normal ${trigger.warn ? AMBER_TEXT : "text-foreground"}`
          }
          data-testid={`${testPrefix}-${testKey}`}
        >
          <TriggerIcon className={compact ? "size-3" : "size-4"} />
          <span className="max-w-[14rem] min-w-0 truncate">{trigger.label}</span>
          <ChevronDown className={`${compact ? "size-3" : "size-4"} ml-auto opacity-60`} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={`max-w-[20rem] ${compact ? "" : "min-w-(--radix-dropdown-menu-trigger-width)"}`}
      >
        {title && <DropdownMenuLabel className="text-[0.7rem]">{title}</DropdownMenuLabel>}
        {/* The cascade's turn comes first: the default, then what is chosen over it, then none.
            Going back to one of them is picking it. */}
        {showModes && inherit && (
          <DropdownMenuItem
            {...modeRow(shown === "inherit")}
            disabled={busy}
            onSelect={() => {
              if (storedMode !== "inherit") onInherit();
            }}
            data-testid={`${testPrefix}-reset-${testKey}`}
          >
            <RadioDot checked={shown === "inherit"} />
            <ChoiceLabel
              label={t("detail.integrationMemberPicker.inherit")}
              description={inherit.description}
            />
          </DropdownMenuItem>
        )}
        {showModes && hasList && (
          <DropdownMenuItem
            {...modeRow(shown === "choose")}
            onSelect={(e) => {
              // It only opens the boxes below: the menu stays for the ticks.
              e.preventDefault();
              setChoosing(true);
            }}
            data-testid={`${testPrefix}-choose-${testKey}`}
          >
            <RadioDot checked={shown === "choose"} />
            <ChoiceLabel
              label={t("detail.integrationMemberPicker.modeChoose")}
              description={t("detail.integrationMemberPicker.modeChooseHint")}
            />
          </DropdownMenuItem>
        )}
        {hasList && (
          <div
            role="group"
            className={showModes ? "border-border mb-1 ml-4 border-l pl-1" : undefined}
          >
            {rows.map((row) => {
              const isChecked = checkedIds.includes(row.id);
              return (
                <DropdownMenuItem
                  key={row.id}
                  // The row is the checkbox a screen reader sees; the box is a glyph.
                  role="menuitemcheckbox"
                  aria-checked={isChecked}
                  disabled={busy || (!isChecked && (atCap || row.disabled === true))}
                  // Toggling must not close the menu: a set is ticked box by box.
                  onSelect={(e) => {
                    e.preventDefault();
                    onToggle(row.id);
                  }}
                  data-testid={`${testPrefix}-option-${row.id}`}
                >
                  <Checkbox
                    checked={isChecked}
                    aria-hidden
                    tabIndex={-1}
                    className="pointer-events-none"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    {/* An incompatible row is muted on its name; its reason stays legible. */}
                    <span className={`truncate font-medium ${row.muted ? "opacity-60" : ""}`}>
                      {row.name}
                    </span>
                    {row.description && (
                      <span className="text-muted-foreground text-[0.65rem] break-words">
                        {row.description}
                      </span>
                    )}
                    {row.extra}
                  </div>
                  {row.trailing}
                </DropdownMenuItem>
              );
            })}
            {unavailableIds.map((id) => (
              <DropdownMenuItem
                key={id}
                disabled
                role="menuitemcheckbox"
                aria-checked={false}
                data-testid={`${testPrefix}-unavailable-${id}`}
              >
                <Checkbox
                  checked={false}
                  aria-hidden
                  tabIndex={-1}
                  className="pointer-events-none"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium line-through">{unavailableRow.label}</span>
                  {unavailableRow.hint && (
                    <span className="text-muted-foreground truncate text-[0.65rem]">
                      {unavailableRow.hint}
                    </span>
                  )}
                </div>
              </DropdownMenuItem>
            ))}
            {atCap && rows.length > 0 && (
              <DropdownMenuLabel className="text-muted-foreground text-[0.65rem] font-normal">
                {t("detail.integrationMemberPicker.maxReached", {
                  max: MAX_CONNECTIONS_PER_INTEGRATION,
                })}
              </DropdownMenuLabel>
            )}
          </div>
        )}
        {showModes && none && (
          <DropdownMenuItem
            {...modeRow(shown === "none")}
            disabled={busy}
            onSelect={() => {
              if (storedMode !== "none") onNone();
            }}
            data-testid={`${testPrefix}-none-${testKey}`}
          >
            <RadioDot checked={shown === "none"} />
            <ChoiceLabel
              label={t("detail.integrationMemberPicker.none")}
              description={none.description}
            />
          </DropdownMenuItem>
        )}
        {/* Nothing ticked, nothing to write: « Hériter » and « Aucune connexion » write on their own. */}
        {apply && ticking && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!apply.enabled}
              onSelect={(e) => {
                // Stays open on a refused write, so the ticks stay editable.
                e.preventDefault();
                apply.onApply();
              }}
              data-testid={`${testPrefix}-apply-${testKey}`}
            >
              <Check className="size-3.5" />
              <span className="font-medium">
                {t("detail.integrationMemberPicker.apply", { count: checkedIds.length })}
              </span>
            </DropdownMenuItem>
          </>
        )}
        {footer}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * {@link ConnectionChoiceMenu} over a plain list of connections whose choice is a value: each tick
 * is handed to `onChange` at once (a form value, or a write that commits alone). `null` is no
 * choice at this layer, `[]` the explicit « Aucune connexion », so unticking the last box gives
 * `null`. `inheritDescription` offers « Hériter » where the server takes no choice as the
 * cascade; `allowNone` offers « Aucune connexion ».
 */
export function ConnectionSetPicker({
  options,
  value,
  onChange,
  testPrefix,
  testKey,
  unavailableIds = NONE,
  disabled = false,
  allowNone = false,
  noneHint,
  inheritDescription,
  placeholder,
}: {
  options: readonly SetOption[];
  value: ConnectionSet;
  onChange: (next: ConnectionSet) => void;
  testPrefix: string;
  testKey: string;
  unavailableIds?: readonly string[];
  disabled?: boolean;
  allowNone?: boolean;
  /** Overrides the default « runs without this integration » line of the none mode. */
  noneHint?: string;
  inheritDescription?: string;
  /** What the trigger reads before anything is chosen, when there is no « Hériter » to read. */
  placeholder?: string;
}) {
  const { t } = useTranslation(["agents", "settings"]);
  const picked = value ?? [];
  const named = picked.flatMap((id) => options.find((o) => o.id === id)?.name ?? []);
  const label = (() => {
    if (value === null) {
      return inheritDescription
        ? t("detail.integrationMemberPicker.inherit")
        : (placeholder ?? t("detail.integrationMemberPicker.modeChoose"));
    }
    if (value.length === 0) return t("detail.integrationMemberPicker.none");
    const base =
      named.length === 1
        ? named[0]!
        : t("detail.integrationMemberPicker.selectedCount", { count: named.length });
    return unavailableIds.length > 0
      ? `${base} · ${t("detail.integrationMemberPicker.unavailableCount", { count: unavailableIds.length })}`
      : base;
  })();
  return (
    <ConnectionChoiceMenu
      testPrefix={testPrefix}
      testKey={testKey}
      trigger={{
        label,
        icon: value?.length === 0 ? Ban : Users,
        warn: unavailableIds.length > 0,
      }}
      storedMode={
        value === null
          ? inheritDescription
            ? "inherit"
            : null
          : value.length === 0
            ? "none"
            : "choose"
      }
      {...(inheritDescription ? { inherit: { description: inheritDescription } } : {})}
      {...(allowNone
        ? {
            none: {
              description: noneHint ?? t("detail.integrationMemberPicker.noneHint"),
            },
          }
        : {})}
      rows={options.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        disabled: o.disabled,
      }))}
      checkedIds={picked}
      unavailableIds={unavailableIds}
      unavailableRow={{ label: t("settings:integration.admin.unavailableConnection") }}
      busy={disabled}
      onToggle={(id) => {
        const next = toggleCapped(picked, id);
        onChange(next.length > 0 ? next : null);
      }}
      onInherit={() => onChange(null)}
      onNone={() => onChange([])}
    />
  );
}
