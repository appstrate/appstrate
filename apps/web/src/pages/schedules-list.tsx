import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFlows, useFlowDetail } from "../hooks/use-flows";
import {
  useAllSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import { ScheduleModal } from "../components/schedule-modal";
import { ScheduleRow } from "../components/schedule-row";
import { LoadingState, ErrorState } from "../components/page-states";
import type { Schedule } from "@appstrate/shared-types";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: schedules, isLoading, error } = useAllSchedules();
  const { data: flows } = useFlows();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [createOpen, setCreateOpen] = useState(false);
  const [createFlowId, setCreateFlowId] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const { data: createFlowDetail } = useFlowDetail(createFlowId || undefined);
  const { data: editFlowDetail } = useFlowDetail(editingSchedule?.flow_id || undefined);
  const createMutation = useCreateSchedule(createFlowId);

  if (isLoading) return <LoadingState />;

  if (error) return <ErrorState message={error.message} />;

  const openCreate = () => {
    setCreateFlowId(flows?.[0]?.id ?? "");
    setCreateOpen(true);
  };

  const openEdit = (sched: Schedule) => {
    setEditingSchedule(sched);
    setEditOpen(true);
  };

  return (
    <>
      <div className="section-header">
        <div className="section-title">{t("schedules.title")}</div>
        <button onClick={openCreate} disabled={!flows || flows.length === 0}>
          {t("btn.add")}
        </button>
      </div>

      {!schedules || schedules.length === 0 ? (
        <div className="empty-state">
          <p>{t("schedules.empty")}</p>
          <p className="empty-hint">{t("schedules.emptyHint")}</p>
        </div>
      ) : (
        <div className="schedule-list">
          {schedules.map((sched) => {
            const flowName =
              flows?.find((f) => f.id === sched.flow_id)?.displayName ?? sched.flow_id;
            return (
              <div key={sched.id} className="schedule-list-item">
                <Link className="schedule-flow-link" to={`/flows/${sched.flow_id}`}>
                  {flowName}
                </Link>
                <ScheduleRow schedule={sched} onClick={() => openEdit(sched)} />
              </div>
            );
          })}
        </div>
      )}

      {/* Step 1: pick a flow before opening the schedule modal */}
      {createOpen && !createFlowId
        ? null
        : createOpen && (
            <>
              {/* Flow picker as a mini-modal, then the schedule modal */}
              <ScheduleModal
                open
                onClose={() => setCreateOpen(false)}
                onSave={(data) => createMutation.mutate(data)}
                isPending={createMutation.isPending}
                inputSchema={createFlowDetail?.input?.schema}
                flowPicker={
                  flows && flows.length > 1 ? (
                    <div className="form-group">
                      <label htmlFor="sched-flow">{t("schedules.flowLabel")}</label>
                      <select
                        id="sched-flow"
                        value={createFlowId}
                        onChange={(e) => setCreateFlowId(e.target.value)}
                      >
                        {flows.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : undefined
                }
              />
            </>
          )}

      {editOpen && editingSchedule && (
        <ScheduleModal
          open
          onClose={() => {
            setEditOpen(false);
            setEditingSchedule(null);
          }}
          schedule={editingSchedule}
          inputSchema={editFlowDetail?.input?.schema}
          onSave={(data) => updateSchedule.mutate({ id: editingSchedule.id, ...data })}
          onDelete={() => {
            deleteSchedule.mutate(editingSchedule.id);
            setEditOpen(false);
            setEditingSchedule(null);
          }}
          isPending={updateSchedule.isPending}
        />
      )}
    </>
  );
}
