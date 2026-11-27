// SPDX-License-Identifier: Apache-2.0

/**
 * The space an action naming no space acts in, chosen where the action is (`useSpaceAction`'s
 * `choose`): its own trigger opens a menu of the spaces it may act in, under a label naming the
 * deed (« Créer dans… »). The catalogue's « Ajouter à… » (`CatalogueAddButton`) is the same menu
 * as a menu of checkboxes: each entry says whether the deed is done there, and a click undoes it
 * where it may be undone. One click on a space acts; nothing else is asked.
 */
import type { ReactElement, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
 * A space's state in a menu that has one: `checked` where the deed is done, `disabled` where the
 * click would be refused (undoing it is not the reader's), `note` a text at the entry's end.
 */
interface SpaceEntryState {
  checked: boolean;
  disabled?: boolean;
  note?: string;
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
        if (!states) {
          return (
            <DropdownMenuItem key={space.id} onClick={() => choice.onPick(space.id)}>
              <SpaceName space={space} size="md" className="flex-1" />
            </DropdownMenuItem>
          );
        }
        const state = states(space.id);
        return (
          <DropdownMenuCheckboxItem
            key={space.id}
            checked={state.checked}
            disabled={state.disabled}
            closeOnClick
            onClick={() => choice.onPick(space.id)}
          >
            <SpaceName space={space} size="md" className="flex-1" />
            {state.note && (
              <span className="text-muted-foreground shrink-0 text-xs">{state.note}</span>
            )}
          </DropdownMenuCheckboxItem>
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
  children: ReactElement;
}) {
  if (!choice) return children;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={children} />
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
