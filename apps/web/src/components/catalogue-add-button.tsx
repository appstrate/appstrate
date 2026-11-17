// SPDX-License-Identifier: Apache-2.0

/**
 * The deed and the state of a Découvrir card, in one slot: add the package, or say it is added.
 *
 * With a working space, the working space is the context: « Ajouter » adds it there in one
 * click, and « Ajouté » says it runs there. In « Tous les espaces » no space is the context, so
 * every deed names its space: one possible space is one click (« Ajouter à Default »), several
 * open the menu of spaces (« Ajouter à… »), where it already runs ticked and inert. There the slot
 * also counts the spaces it runs in, since no single space answers « added? ».
 *
 * `spaces` holds only the spaces where it runs or where the reader may add it (`mayActivateIn`),
 * so no deed leads to a refusal; nothing is drawn where there is neither. « Ajouté » is a state,
 * not a control: removal lives in the package's menu and the « Par espace » view.
 *
 * One space per click: a menu of checkboxes is heavier for a rare gesture, and the matrix
 * (« Par espace ») is where several spaces are set at once.
 */
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { SpaceChoiceDropdown } from "./space-choice-menu";
import type { SpaceChoiceMenu } from "../lib/menu-action";

export type AddableSpace = SpaceChoiceMenu["spaces"][number] & {
  /** Already running there: shown ticked, not offered again. */
  active: boolean;
};

/** The button's height and type: the state takes the same, so a card does not jump on a click. */
const SLOT = "h-7 gap-1 px-2 text-xs";

function Added({ label }: { label: string }) {
  return (
    <Badge variant="success" className={`${SLOT} rounded-md font-medium`}>
      <Check className="size-3.5" aria-hidden />
      {label}
    </Badge>
  );
}

export function CatalogueAddButton({
  spaces,
  workingSpaceId,
  busy,
  onAdd,
}: {
  spaces: AddableSpace[];
  /** The space the app works in; null in « Tous les espaces ». */
  workingSpaceId: string | null;
  busy: boolean;
  onAdd: (spaceId: string) => void;
}) {
  const { t } = useTranslation("settings");

  if (workingSpaceId) {
    const working = spaces.find((space) => space.id === workingSpaceId);
    if (!working) return null;
    if (working.active) return <Added label={t("catalogue.added")} />;
    return (
      <Button
        size="sm"
        variant="outline"
        className={SLOT}
        disabled={busy}
        onClick={() => onAdd(working.id)}
      >
        <Plus aria-hidden />
        {t("common:btn.add")}
      </Button>
    );
  }

  const activeIn = new Set(spaces.filter((space) => space.active).map((space) => space.id));
  const toAdd = spaces.filter((space) => !space.active);
  if (toAdd.length === 0) {
    return activeIn.size > 0 ? (
      <Added label={t("catalogue.addedCount", { count: activeIn.size })} />
    ) : null;
  }

  // One space, and nothing elsewhere to show beside it: one click, named.
  if (spaces.length === 1) {
    return (
      <Button
        size="sm"
        variant="outline"
        className={`${SLOT} max-w-44`}
        disabled={busy}
        onClick={() => onAdd(toAdd[0]!.id)}
      >
        <Plus aria-hidden />
        <span className="truncate">{t("catalogue.addTo", { space: toAdd[0]!.name })}</span>
      </Button>
    );
  }

  // Where it already runs stays in the menu, ticked and inert: the picture is whole, and a space
  // does not vanish after a click. The trigger counts those spaces.
  const alreadyIn =
    activeIn.size > 0 ? t("catalogue.addedCount", { count: activeIn.size }) : undefined;
  return (
    <SpaceChoiceDropdown
      choice={{ label: t("catalogue.addToMenu"), spaces, onPick: onAdd }}
      states={(spaceId) => ({
        done: activeIn.has(spaceId) ? t("catalogue.filter.active") : undefined,
      })}
    >
      <Button size="sm" variant="outline" className={SLOT} disabled={busy} title={alreadyIn}>
        <Plus aria-hidden />
        {t("common:btn.add")}
        {alreadyIn && (
          <>
            <span aria-hidden className="text-success flex items-center gap-0.5 tabular-nums">
              <Check />
              {activeIn.size}
            </span>
            <span className="sr-only">{alreadyIn}</span>
          </>
        )}
        <ChevronDown aria-hidden />
      </Button>
    </SpaceChoiceDropdown>
  );
}
