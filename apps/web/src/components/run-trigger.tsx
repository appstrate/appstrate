// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  User,
  Calendar,
  Key,
  UserCircle,
  Terminal,
  Workflow,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { getRunTriggerType } from "../lib/run-trigger";

function runnerIcon(kind: string | null | undefined): LucideIcon {
  if (kind === "cli") return Terminal;
  if (kind === "github-action") return Workflow;
  return Globe;
}

function TriggerLine({
  icon: Icon,
  label,
  title,
  children,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs"
      title={title}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
      {children}
    </span>
  );
}

/**
 * Displays the run trigger as icon + label. Priority order:
 *
 *   1. Schedule (cron-driven)
 *   2. End-user impersonation
 *   3. API key (e.g. CI integrations without runner metadata)
 *   4. Runner label (CLI hostname, GitHub Action workflow, …)
 *   5. Dashboard user
 */
export function RunTrigger({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation("agents");
  if (run.scheduleId) {
    return <TriggerLine icon={Calendar} label={run.schedule_name || t("schedule.unnamed")} />;
  }
  if (run.end_user_name) return <TriggerLine icon={UserCircle} label={run.end_user_name} />;
  if (run.api_key_name) return <TriggerLine icon={Key} label={run.api_key_name} />;
  if (run.runner_name) {
    const tooltip = run.runner_kind ? `${run.runner_name} (${run.runner_kind})` : run.runner_name;
    return (
      <TriggerLine
        icon={runnerIcon(run.runner_kind)}
        label={run.runner_name}
        title={run.user_name ? `${tooltip} · ${run.user_name}` : tooltip}
      >
        {run.user_name ? (
          <>
            <span className="shrink-0">·</span>
            <User size={12} className="shrink-0" />
            <span className="truncate">{run.user_name}</span>
          </>
        ) : null}
      </TriggerLine>
    );
  }
  if (run.user_name) return <TriggerLine icon={User} label={run.user_name} />;
  // Nothing names who launched it (a deleted member or key, a runner with no label): say the
  // kind of launch when the run records one, a dash when it does not.
  const type = getRunTriggerType(run);
  if (type === "manual") return <span className="text-muted-foreground/50">—</span>;
  return <span className="text-muted-foreground text-xs">{t(`run.triggerType.${type}`)}</span>;
}
