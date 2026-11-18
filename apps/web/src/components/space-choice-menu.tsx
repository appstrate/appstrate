// SPDX-License-Identifier: Apache-2.0

/**
 * The space an action naming no space acts in, chosen where the action is (`useSpaceAction`'s
 * `choose`): its own trigger opens a menu of the spaces it may act in, under a label naming the
 * deed (« Créer dans… »). The catalogue's « Ajouter à… » (`CatalogueAddButton`) is the same menu,
 * its entries carrying a state. One click on a space acts; nothing else is asked.
 */
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { SpaceChoiceMenu } from "../lib/menu-action";
import { SpaceName } from "./space-name";

/**
 * A space's state in a menu that has one: `done` ticks it, inert, its text at the end (where the
 * deed is already done).
 */
interface SpaceEntryState {
  done?: string;
}

type EntryStates = (spaceId: string) => SpaceEntryState;

/** The menu's body: its label, then one entry per space. */
function SpaceChoiceItems({ choice, states }: { choice: SpaceChoiceMenu; states?: EntryStates }) {
  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
        {choice.label}
      </DropdownMenuLabel>
      {choice.spaces.map((space) => {
        const state = states?.(space.id);
        return (
          <DropdownMenuItem
            key={space.id}
            disabled={!!state?.done}
            onSelect={() => choice.onPick(space.id)}
          >
            {states && <Check className={state?.done ? "text-success" : "invisible"} aria-hidden />}
            <SpaceName space={space} size="md" className="flex-1" />
            {state?.done && (
              <span className="text-muted-foreground shrink-0 text-xs">{state.done}</span>
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * `children` (a button, a link) as the trigger of the menu of spaces when there is a choice;
 * as they are otherwise. The trigger's own click does nothing then (`useSpaceAction`'s `run`).
 */
export function SpaceChoiceDropdown({
  choice,
  states,
  children,
}: {
  choice: SpaceChoiceMenu | undefined;
  states?: EntryStates;
  children: ReactNode;
}) {
  if (!choice) return <>{children}</>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      {/* A portal still bubbles through the React tree: a pick must not reach a row's own click. */}
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        onClick={(event) => event.stopPropagation()}
      >
        <SpaceChoiceItems choice={choice} states={states} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A menu entry whose deed asks for the space first: a sub-menu of them, opened from the entry. */
export function SpaceChoiceSubmenu({
  choice,
  trigger,
  marks,
}: {
  choice: SpaceChoiceMenu;
  trigger: ReactNode;
  marks?: Record<string, string>;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger {...marks}>{trigger}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-56">
        <SpaceChoiceItems choice={choice} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
