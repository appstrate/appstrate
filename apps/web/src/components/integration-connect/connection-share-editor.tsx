// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@appstrate/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@appstrate/ui/components/command";
import { cn } from "@appstrate/ui/cn";
import { useOrgSpaces } from "../../hooks/use-spaces";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { withSpaceShare } from "./connection-ownership";

/**
 * The spaces a connection is shared into: the owner picks any space of the org they reach (only
 * its own for a space-scoped row); a governor only withdraws the current one. A refused removal
 * answers 409 `connection_pinned`. Every write sends the whole replacement set.
 */
export function ConnectionShareEditor({
  connectionId,
  orgId,
  scope,
  sharedSpaceIds,
  ownSpaceId,
  hereSpaceId,
  canEditShares,
  canUnshareHere,
  lockHint,
  pending,
  onChange,
}: {
  connectionId: string;
  orgId: string | null;
  scope: "org" | "space";
  /** As read: the owner's full set, anyone else's projection of the current space. */
  sharedSpaceIds: string[];
  /** The one space a space-scoped row lives in. */
  ownSpaceId: string | null;
  /** The space the page acts in; null outside one. */
  hereSpaceId: string | null;
  canEditShares: boolean;
  canUnshareHere: boolean;
  /** Why a governor's withdrawal here is refused; the owner's edits ignore it. */
  lockHint: string | null;
  pending: boolean;
  onChange: (sharedSpaceIds: string[]) => void;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const { data: spaces } = useOrgSpaces(canEditShares && scope === "org" ? orgId : null);

  if (canEditShares && scope === "space") {
    return (
      <label
        className="flex items-center gap-1.5 text-xs"
        title={t("integration.connection.share.thisSpaceHelp")}
      >
        <input
          type="checkbox"
          checked={!!ownSpaceId && sharedSpaceIds.includes(ownSpaceId)}
          disabled={pending || !ownSpaceId}
          onChange={(e) => {
            if (ownSpaceId) onChange(withSpaceShare(sharedSpaceIds, ownSpaceId, e.target.checked));
          }}
          data-testid={`share-toggle-${connectionId}`}
        />
        {t("integration.connection.share.thisSpace")}
      </label>
    );
  }

  if (canEditShares) {
    const targets = (spaces ?? []).filter((s) => s.access === "member");
    const names = targets.filter((s) => sharedSpaceIds.includes(s.id)).map((s) => s.name);
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 max-w-[16rem] justify-between gap-1.5 text-xs font-normal"
            disabled={pending}
            title={names.join(", ") || t("integration.connection.share.help")}
            data-testid={`share-editor-${connectionId}`}
          >
            <span className="truncate">
              {sharedSpaceIds.length === 0
                ? t("integration.connection.share.none")
                : t("integration.connection.share.count", { count: sharedSpaceIds.length })}
            </span>
            <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("integration.connection.share.search")} />
            <CommandList>
              <CommandEmpty>{t("integration.connection.share.noSpace")}</CommandEmpty>
              <CommandGroup heading={t("integration.connection.share.help")}>
                {targets.map((space) => {
                  const selected = sharedSpaceIds.includes(space.id);
                  return (
                    <CommandItem
                      key={space.id}
                      value={`${space.name} ${space.id}`}
                      disabled={pending}
                      onSelect={() => onChange(withSpaceShare(sharedSpaceIds, space.id, !selected))}
                      data-testid={`share-target-${connectionId}-${space.id}`}
                    >
                      <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                      <span className="truncate">{space.name}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }

  if (canUnshareHere && hereSpaceId) {
    return (
      <DisabledReasonTooltip reason={lockHint}>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={pending || !!lockHint}
          title={lockHint ? undefined : t("integration.connection.share.removeHereHelp")}
          onClick={() => onChange(withSpaceShare(sharedSpaceIds, hereSpaceId, false))}
          data-testid={`share-remove-here-${connectionId}`}
        >
          {t("integration.connection.share.removeHere")}
        </Button>
      </DisabledReasonTooltip>
    );
  }

  return (
    <span className="text-muted-foreground text-xs">
      {hereSpaceId && sharedSpaceIds.includes(hereSpaceId)
        ? t("integration.connection.share.sharedHere")
        : "—"}
    </span>
  );
}
