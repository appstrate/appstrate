// SPDX-License-Identifier: Apache-2.0

/**
 * The deed of a Découvrir card whose package the reader's space does not run:
 * add it — and always say WHERE.
 *
 * It used to read "Ajouter" and meant "in the space the app is in", which the
 * card never wrote. Now the space is named: one possible space is one click
 * ("Ajouter à Default"); several open a menu of them, the reader's own first
 * and marked "ici". The list holds only the spaces where adding is allowed
 * (`mayActivateIn`), so no item leads to a refusal.
 *
 * Two deeds share the word, and the menu says which is which. Where a share
 * already WAITS, adding takes it up — the activation right there is enough.
 * Anywhere else, adding makes the READER share it first, which their share
 * right in the package's home allows. So a space is marked "Partage en
 * attente", a STATE, and never "Partagé par Julie": an author read as the
 * condition for adding, and the other spaces then looked forbidden.
 *
 * One space per click: a menu of checkboxes is heavier for a rare gesture, and
 * the matrix ("Par espace") is where several spaces are set at once.
 */
import { useTranslation } from "react-i18next";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

export interface AddableSpace {
  id: string;
  name: string;
  /** A share already waits there: adding it is taking that share up. */
  pending: boolean;
}

export function CatalogueAddButton({
  spaces,
  currentSpaceId,
  busy,
  onAdd,
}: {
  spaces: AddableSpace[];
  currentSpaceId: string | null;
  busy: boolean;
  onAdd: (spaceId: string) => void;
}) {
  const { t } = useTranslation("settings");
  if (spaces.length === 0) return null;

  if (spaces.length === 1) {
    const only = spaces[0]!;
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 max-w-44 gap-1 px-2 text-xs"
        disabled={busy}
        onClick={() => onAdd(only.id)}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{t("catalogue.addTo", { space: only.name })}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" disabled={busy}>
          <Plus className="size-3.5" aria-hidden />
          {t("catalogue.addToSpace")}
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
          {t("catalogue.addToMenu")}
        </DropdownMenuLabel>
        {spaces.map((space) => (
          <DropdownMenuItem key={space.id} onSelect={() => onAdd(space.id)}>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate">{space.name}</span>
              {space.id === currentSpaceId && (
                <span className="bg-primary/15 text-primary rounded px-1 text-[10px] leading-4 font-medium">
                  {t("catalogue.here")}
                </span>
              )}
            </span>
            {space.pending && (
              <span className="text-primary shrink-0 text-xs">{t("catalogue.pendingHere")}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
