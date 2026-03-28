import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFlows, usePackageDetail } from "../hooks/use-packages";
import {
  useAllSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import { ScheduleModal } from "../components/schedule-modal";
import { ScheduleRow } from "../components/schedule-row";
import { Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import type { Schedule } from "@appstrate/shared-types";
import { isFileField } from "@appstrate/core/form";

export function SchedulesListPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { t: tFlows } = useTranslation(["flows"]);
  const { data: schedules, isLoading, error } = useAllSchedules();
  const { data: flows } = useFlows();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [createOpen, setCreateOpen] = useState(false);
  const [createFlowId, setCreateFlowId] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const { data: createFlowDetail } = usePackageDetail("flow", createFlowId || undefined);
  const { data: editFlowDetail } = usePackageDetail(
    "flow",
    editingSchedule?.packageId || undefined,
  );
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
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-medium text-muted-foreground">{t("schedules.title")}</div>
        <Button onClick={openCreate} disabled={!flows || flows.length === 0}>
          {t("btn.add")}
        </Button>
      </div>

      {!schedules || schedules.length === 0 ? (
        <EmptyState message={t("schedules.empty")} hint={t("schedules.emptyHint")} icon={Calendar}>
          <Button onClick={openCreate} disabled={!flows || flows.length === 0}>
            {t("btn.add")}
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-1">
          {schedules.map((sched) => {
            const flowName =
              flows?.find((f) => f.id === sched.packageId)?.displayName ?? sched.packageId;
            return (
              <div key={sched.id} className="border-b border-border last:border-0">
                <Link
                  className="text-xs text-muted-foreground hover:text-foreground px-3 pt-2 block"
                  to={`/flows/${sched.packageId}`}
                >
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
                blockedMessage={
                  createFlowDetail?.input?.schema?.properties &&
                  Object.values(createFlowDetail.input.schema.properties).some(isFileField)
                    ? tFlows("schedule.fileInputBlocked")
                    : undefined
                }
                flowPicker={
                  flows && flows.length > 0 ? (
                    <div className="space-y-2">
                      <Label htmlFor="sched-flow">{t("schedules.flowLabel")}</Label>
                      <Select value={createFlowId} onValueChange={setCreateFlowId}>
                        <SelectTrigger id="sched-flow">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {flows.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
