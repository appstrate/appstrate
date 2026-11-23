// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces the open conversation touched, as icons at the right of the chat's top bar: the
 * tiles of the first ones (the rest counted « +N ») in one button that never wraps. Hover or
 * focus names them, a click opens a read-only list of each (tile and name). A conversation that touched
 * none draws nothing. The spaces are the open conversation's server row (`useActiveSession`),
 * refetched by the session signal when it touches a new one.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { ChatTransport } from "@appstrate/module-chat/ui";
import { useActiveSession } from "@appstrate/module-chat/unread";
import { SpaceName, SpaceTileStack, type SpaceListed } from "../../components/space-name";
import { useSpacesOf } from "../../hooks/use-spaces";
import { spaceLabels } from "../../lib/space-label";

/** Tiles drawn in the trigger before the rest is counted. */
const VISIBLE_SPACE_TILES = 3;

/** The control for spaces already read: the trigger and its read-only list. */
export function ConversationSpacesControl({
  spaces,
}: {
  spaces: readonly (SpaceListed & { id: string })[];
}) {
  const { t } = useTranslation(["chat", "settings"]);
  if (spaces.length === 0) return null;
  const names = spaceLabels(spaces, t);
  const label = t("chat:spaces.trigger", { names });
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // The stacked tiles ring themselves in the button's background, at rest or hovered.
              className="desktop-pointer:h-8 h-11 shrink-0 px-2 [--tile-ring:var(--canvas)] hover:[--tile-ring:var(--accent)]"
              aria-label={label}
              data-testid="conversation-spaces"
            >
              <SpaceTileStack spaces={spaces} max={VISIBLE_SPACE_TILES} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{names}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-auto min-w-48 p-3">
        <p className="text-muted-foreground text-xs font-medium">{t("chat:spaces.title")}</p>
        <ul className="mt-2 flex flex-col gap-2">
          {spaces.map((space) => (
            <li key={space.id} className="flex min-w-0">
              <SpaceName space={space} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** {@link ConversationSpacesControl} of a stored conversation, read by id. */
export function ConversationSpaces({
  conversationId,
  transport,
}: {
  conversationId: string | null;
  transport: ChatTransport | undefined;
}) {
  const row = useActiveSession(transport, conversationId ?? "", conversationId !== null);
  const spaces = useSpacesOf(row?.space_ids ?? []);
  return <ConversationSpacesControl spaces={spaces} />;
}
