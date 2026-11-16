// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces the open conversation touched, as icons at the right of the chat's top bar: the
 * tiles of the first ones (the rest counted « +N ») in one button that never wraps. Hover or
 * focus names them, a click lists each (tile and name), read-only. A conversation that touched
 * none draws nothing. The spaces come from the conversation itself (the list's row meanwhile):
 * they follow its refetch when it touches a new one.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSessions } from "@appstrate/module-chat/unread";
import { $api } from "../../api/client";
import { SpaceName, SpaceTile } from "../../components/space-name";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useSpacesOf } from "../../hooks/use-spaces";
import { spaceLabel } from "../../lib/space-label";

/** Tiles drawn in the trigger before the rest is counted. */
export const VISIBLE_SPACE_TILES = 3;

type SpaceListed = Parameters<typeof SpaceTile>[0]["space"];

/** The control for spaces already read: the trigger and its read-only list. */
export function ConversationSpacesControl({
  spaces,
}: {
  spaces: readonly (SpaceListed & { id: string })[];
}) {
  const { t } = useTranslation(["chat", "settings"]);
  if (spaces.length === 0) return null;
  const names = spaces.map((space) => spaceLabel(space, t)).join(", ");
  const label = t("chat:spaces.trigger", { names });
  const hidden = spaces.length - VISIBLE_SPACE_TILES;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-auto h-8 shrink-0 gap-0.5 px-2"
              aria-label={label}
              data-testid="conversation-spaces"
            >
              {spaces.slice(0, VISIBLE_SPACE_TILES).map((space) => (
                <SpaceTile key={space.id} space={space} />
              ))}
              {hidden > 0 && (
                <span className="bg-muted text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] leading-none font-medium tabular-nums">
                  +{hidden}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{names}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{t("chat:spaces.title")}</DropdownMenuLabel>
        <ul className="flex flex-col gap-2 px-2 py-1.5">
          {spaces.map((space) => (
            <li key={space.id} className="flex min-w-0">
              <SpaceName space={space} />
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** {@link ConversationSpacesControl} of a stored conversation, read by id. */
export function ConversationSpaces({ conversationId }: { conversationId: string | null }) {
  const orgId = useCurrentOrgId();
  const { data: sessions } = useSessions();
  const listed = conversationId ? sessions?.find((s) => s.id === conversationId) : undefined;
  // The same query as the title crumb's and the info panel's, refetched by the session signal.
  const detail = $api.useQuery(
    "get",
    "/api/orgs/{orgId}/chat/sessions/{id}",
    { params: { path: { orgId: orgId ?? "", id: conversationId ?? "" } } },
    { enabled: !!orgId && !!conversationId },
  );
  const spaces = useSpacesOf(detail.data?.space_ids ?? listed?.space_ids ?? []);
  return <ConversationSpacesControl spaces={spaces} />;
}
