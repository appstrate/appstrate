// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Badge as UIBadge } from "@/components/ui/badge";
import { Calendar, Clock } from "lucide-react";
import { formatDateField } from "../lib/markdown";

interface NextExecutionPreviewProps {
  executionNumber: number;
  flowName?: string;
  scheduleName: string;
  nextRunAt: string | Date;
  className?: string;
}

export function NextExecutionPreview({
  executionNumber,
  flowName,
  scheduleName,
  nextRunAt,
  className,
}: NextExecutionPreviewProps) {
  const { t } = useTranslation(["flows"]);

  return (
    <div className={`flex items-center gap-2 px-3 py-2 text-sm opacity-50 ${className ?? ""}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-muted-foreground shrink-0 font-mono text-xs">#{executionNumber}</span>
        {flowName && <span className="truncate font-medium">{flowName}</span>}
        <UIBadge variant="secondary" className="shrink-0 gap-1">
          <Clock className="size-3" />
          {t("schedule.scheduled")}
        </UIBadge>
        <span className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs sm:inline-flex">
          <Calendar className="size-3" />
          <span className="max-w-[150px] truncate">{scheduleName}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs">{formatDateField(nextRunAt)}</span>
        </div>
      </div>
    </div>
  );
}
