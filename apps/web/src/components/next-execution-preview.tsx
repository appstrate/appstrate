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
      <div className="flex flex-1 items-center gap-2 min-w-0">
        <span className="text-muted-foreground font-mono text-xs shrink-0">#{executionNumber}</span>
        {flowName && <span className="font-medium truncate">{flowName}</span>}
        <UIBadge variant="secondary" className="gap-1 shrink-0">
          <Clock className="size-3" />
          {t("schedule.scheduled")}
        </UIBadge>
        <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground text-xs shrink-0">
          <Calendar className="size-3" />
          <span className="truncate max-w-[150px]">{scheduleName}</span>
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-muted-foreground text-xs">{formatDateField(nextRunAt)}</span>
        </div>
      </div>
    </div>
  );
}
