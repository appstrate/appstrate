// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's approval mode picker: ask before every writing action, or act
 * straight away. Same shape as a coding agent's mode menu (a trigger naming the
 * current mode, a list of modes with a one-line description and a check).
 */

import { CheckIcon, HandIcon, ZapIcon, type LucideIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { setToolApprovalEnabled, useToolApprovalEnabled } from "./tool-approval-store.ts";
import { useChatHost } from "./runtime-context.ts";

const MODES: { enabled: boolean; Icon: LucideIcon; key: "ask" | "auto" }[] = [
  { enabled: true, Icon: HandIcon, key: "ask" },
  { enabled: false, Icon: ZapIcon, key: "auto" },
];

export function ToolApprovalModeSelect() {
  const { t } = useChatHost();
  const enabled = useToolApprovalEnabled();
  const current = MODES.find((mode) => mode.enabled === enabled)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("approvalMode.label")}
          className="text-muted-foreground h-8 shrink-0 gap-1.5 rounded-lg px-2"
        >
          <current.Icon className="size-4" />
          {t(`approvalMode.${current.key}.short`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-80">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {t("approvalMode.label")}
        </DropdownMenuLabel>
        {MODES.map(({ enabled: value, Icon, key }) => (
          <DropdownMenuItem
            key={key}
            onSelect={() => setToolApprovalEnabled(value)}
            className="items-start gap-3 py-2"
          >
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1 space-y-0.5">
              <span className="block font-medium">{t(`approvalMode.${key}.title`)}</span>
              <span className="text-muted-foreground block text-xs">
                {t(`approvalMode.${key}.hint`)}
              </span>
            </span>
            {value === enabled ? <CheckIcon className="mt-0.5 size-4 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
