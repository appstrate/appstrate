// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ConnectionScope } from "@appstrate/shared-types";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
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
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";

/**
 * The spaces a connection is shared into. Which controls show is decided by the caller from the
 * row's `allowed_actions`; the editor only renders them and reports the space to share or withdraw.
 */
export function ConnectionShareEditor({
  connectionId,
  scope,
  rowSpaceId,
  hereSpaceId,
  targets,
  teamSpaceIds,
  sharedSpaceIds,
  sharedHere,
  canShare,
  canUnshareHere,
  lockHint,
  pending,
  onShare,
  canShareAll,
  shareNewSpaces,
  onFutureSharingChange,
  onUnshare,
}: {
  connectionId: string;
  scope: ConnectionScope;
  /** The one space a space-scoped row lives in; its share toggle targets that space. */
  rowSpaceId: string | null;
  /** The space the request is made from: the target of a governor's withdrawal. */
  hereSpaceId: string | null;
  /** Spaces offered in the picker, with their names. */
  targets: { id: string; name: string }[];
  /** Every team space in the organization; undefined until its listing is loaded. */
  teamSpaceIds: string[] | undefined;
  /** The owner's full set of shared spaces; empty for anyone else. */
  sharedSpaceIds: string[];
  /** Whether the connection is shared into `hereSpaceId`. */
  sharedHere: boolean;
  canShare: boolean;
  canUnshareHere: boolean;
  /** Why a governor's withdrawal here is refused; the owner's edits ignore it. */
  lockHint: string | null;
  pending: boolean;
  onShare: (spaceId: string) => void;
  canShareAll: boolean;
  shareNewSpaces: boolean;
  onFutureSharingChange: (enabled: boolean) => void;
  onUnshare: (spaceId: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);

  if (canShare && scope === "space") {
    return (
      <label
        className="flex items-center gap-1.5 text-xs"
        title={t("integration.connection.share.thisSpaceHelp")}
      >
        <Checkbox
          checked={!!rowSpaceId && sharedSpaceIds.includes(rowSpaceId)}
          disabled={pending || !rowSpaceId}
          onCheckedChange={(checked) => {
            if (!rowSpaceId) return;
            if (checked === true) onShare(rowSpaceId);
            else onUnshare(rowSpaceId);
          }}
          data-testid={`share-toggle-${connectionId}`}
        />
        {t("integration.connection.share.thisSpace")}
      </label>
    );
  }

  if (canShare) {
    const names = targets.filter((s) => sharedSpaceIds.includes(s.id)).map((s) => s.name);
    const allShared =
      canShareAll &&
      shareNewSpaces &&
      teamSpaceIds !== undefined &&
      teamSpaceIds.every((id) => sharedSpaceIds.includes(id));
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 max-w-full min-w-0 justify-between gap-1 px-1.5 text-xs font-normal"
            disabled={pending}
            title={names.join(", ") || t("integration.connection.share.help")}
            data-testid={`share-editor-${connectionId}`}
          >
            <span className="truncate">
              {allShared
                ? t("integration.connection.share.all")
                : shareNewSpaces
                  ? t("integration.connection.share.custom")
                  : sharedSpaceIds.length === 0
                    ? t("integration.connection.share.none")
                    : t("integration.connection.share.count", { count: sharedSpaceIds.length })}
            </span>
            <ChevronsUpDown className="shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="flex flex-col gap-2 p-3">
            <p className="text-muted-foreground text-xs">
              {t("integration.connection.share.help")}
            </p>
            {canShareAll && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={allShared ? true : shareNewSpaces ? "indeterminate" : false}
                    disabled={pending}
                    onCheckedChange={(checked) => onFutureSharingChange(checked === true)}
                    aria-describedby={`share-all-help-${connectionId}`}
                    data-testid={`share-all-${connectionId}`}
                  />
                  {t("integration.connection.share.all")}
                </label>
                <p id={`share-all-help-${connectionId}`} className="text-muted-foreground text-xs">
                  {t("integration.connection.share.allHelp")}
                </p>
              </>
            )}
          </div>
          <Command>
            <CommandInput placeholder={t("integration.connection.share.search")} />
            <CommandList>
              <CommandEmpty>{t("viewAs.noSpace")}</CommandEmpty>
              <CommandGroup>
                {targets.map((space) => {
                  const selected = sharedSpaceIds.includes(space.id);
                  return (
                    <CommandItem
                      key={space.id}
                      value={`${space.name} ${space.id}`}
                      disabled={pending}
                      onSelect={() => (selected ? onUnshare(space.id) : onShare(space.id))}
                      data-testid={`share-target-${connectionId}-${space.id}`}
                    >
                      <Check className={cn(selected ? "opacity-100" : "opacity-0")} />
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
          onClick={() => onUnshare(hereSpaceId)}
          data-testid={`share-remove-here-${connectionId}`}
        >
          {t("integration.connection.share.removeHere")}
        </Button>
      </DisabledReasonTooltip>
    );
  }

  return (
    <span className="text-muted-foreground text-xs">
      {sharedHere ? t("integration.connection.share.sharedHere") : "—"}
    </span>
  );
}
