import type { Schedule } from "@openflows/shared-types";

interface ScheduleRowProps {
  schedule: Schedule;
  onClick: () => void;
  showFlowId?: boolean;
}

export function ScheduleRow({ schedule, onClick, showFlowId }: ScheduleRowProps) {
  return (
    <button type="button" className="schedule-row" onClick={onClick}>
      <span className={`schedule-status ${schedule.enabled ? "enabled" : "disabled"}`} />
      <span className="schedule-cron">{schedule.cron_expression}</span>
      {schedule.name && <span className="schedule-name">{schedule.name}</span>}
      {showFlowId && <span className="schedule-flow-id">{schedule.flow_id}</span>}
      <span className="schedule-tz">{schedule.timezone}</span>
      {schedule.next_run_at && (
        <span className="schedule-next">
          {new Date(schedule.next_run_at).toLocaleString("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </button>
  );
}
