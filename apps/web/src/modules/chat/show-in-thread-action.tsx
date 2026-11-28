// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { MessageSquareIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";

/** "See in the thread", and under it the note that the last reveal found no line. */
export function ShowInThreadAction({
  missing,
  missedLabel,
  onShowInThread,
  className,
  children,
}: {
  missing: boolean;
  missedLabel: string;
  onShowInThread: () => void;
  className?: string;
  /** Actions drawn after it, on the same row. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="desktop-pointer:h-9 h-10"
          onClick={onShowInThread}
        >
          <MessageSquareIcon />
          {t("context.showInThread")}
        </Button>
        {children}
      </div>
      {missing ? <p className="text-muted-foreground text-xs">{missedLabel}</p> : null}
    </div>
  );
}
