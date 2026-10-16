// SPDX-License-Identifier: Apache-2.0

import { ManualSetting } from "../settings/manual-save";
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
  sharedSpaceIds,
  sharedHere,
  canShare,
  canUnshareHere,
  lockHint,
  pending,
  onShare,
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
  /** The owner's full set of shared spaces; empty for anyone else. */
  sharedSpaceIds: string[];
  /** Whether the connection is shared into `hereSpaceId`. */
  sharedHere: boolean;
  canShare: boolean;
  canUnshareHere: boolean;
  /** Why a governor's withdrawal here is refused; the owner's edits ignore it. */
  lockHint: string | null;
  pending: boolean;
  onShare: (spaceId: string) => Promise<unknown>;
  onUnshare: (spaceId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);

  if (canShare && scope === "space") {
    return (
      <ManualSetting
        compact
        value={!!rowSpaceId && sharedSpaceIds.includes(rowSpaceId)}
        disabled={pending || !rowSpaceId}
        onSave={(shared) => (shared ? onShare(rowSpaceId!) : onUnshare(rowSpaceId!))}
      >
        {(shared, setShared, busy) => (
          <label
            className="flex items-center gap-1.5 text-xs"
            title={t("integration.connection.share.thisSpaceHelp")}
          >
            <Checkbox
              checked={shared}
              disabled={busy}
              onCheckedChange={(checked) => setShared(checked === true)}
              data-testid={`share-toggle-${connectionId}`}
            />
            {t("integration.connection.share.thisSpace")}
          </label>
        )}
      </ManualSetting>
    );
  }

  if (canShare) {
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
            <ChevronsUpDown className="shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder={t("integration.connection.share.search")} />
            <CommandList>
              <CommandEmpty>{t("viewAs.noSpace")}</CommandEmpty>
              <CommandGroup heading={t("integration.connection.share.help")}>
                {targets.map((space) => {
                  const selected = sharedSpaceIds.includes(space.id);
                  return (
                    <ManualSetting
                      compact
                      key={space.id}
                      value={selected}
                      disabled={pending}
                      onSave={(shared) => (shared ? onShare(space.id) : onUnshare(space.id))}
                    >
                      {(shared, setShared, busy) => (
                        <CommandItem
                          key={space.id}
                          value={`${space.name} ${space.id}`}
                          disabled={busy}
                          onSelect={() => setShared(!shared)}
                          data-testid={`share-target-${connectionId}-${space.id}`}
                        >
                          <Check className={cn(shared ? "opacity-100" : "opacity-0")} />
                          <span className="truncate">{space.name}</span>
                        </CommandItem>
                      )}
                    </ManualSetting>
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
          onClick={() => {
            void onUnshare(hereSpaceId).catch(() => {});
          }}
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
