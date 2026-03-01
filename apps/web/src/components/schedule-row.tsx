import type { Schedule } from "@appstrate/shared-types";
import { formatDateField } from "../lib/markdown";

interface ScheduleRowProps {
  schedule: Schedule;
  onClick: () => void;
  showFlowId?: boolean;
}

export function ScheduleRow({ schedule, onClick, showFlowId }: ScheduleRowProps) {
  return (
    <button type="button" className="schedule-row" onClick={onClick}>
      <span className={`schedule-status ${schedule.enabled ? "enabled" : "disabled"}`} />
      <span className="schedule-cron">{schedule.cronExpression}</span>
      {schedule.name && <span className="schedule-name">{schedule.name}</span>}
      {showFlowId && <span className="schedule-flow-id">{schedule.packageId}</span>}
      <span className="schedule-tz">{schedule.timezone ?? "UTC"}</span>
      {schedule.nextRunAt && (
        <span className="schedule-next">{formatDateField(schedule.nextRunAt)}</span>
      )}
    </button>
  );
}
