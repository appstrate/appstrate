import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Schedule } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";

interface ScheduleRowProps {
  schedule: Schedule;
  onClick: () => void;
  showFlowId?: boolean;
}

export function ScheduleRow({ schedule, onClick, showFlowId }: ScheduleRowProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="flex items-center gap-3 w-full justify-start px-3 py-2 h-auto text-sm font-normal"
      onClick={onClick}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          schedule.enabled ? "bg-success" : "bg-muted-foreground",
        )}
      />
      <span className="font-mono text-xs">{schedule.cronExpression}</span>
      {schedule.name && <span className="font-medium truncate">{schedule.name}</span>}
      {showFlowId && (
        <span className="text-muted-foreground text-xs truncate">{schedule.packageId}</span>
      )}
      <span className="text-muted-foreground text-xs">{schedule.timezone ?? "UTC"}</span>
      {schedule.nextRunAt && (
        <span className="text-muted-foreground text-xs ml-auto">
          {formatDateField(schedule.nextRunAt)}
        </span>
      )}
    </Button>
  );
}
