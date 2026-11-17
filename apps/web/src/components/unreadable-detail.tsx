// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page whose resource the working space cannot read. Out of « Tous les espaces » it says
 * so (`ResourceErrorState`). In the mode the working space is hidden: the page looks the resource
 * up in the list spanning the reader's spaces and reopens in the space holding it, and only says it
 * is unavailable when no reached space does — without naming « cet espace ».
 */

import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAgents, usePackageList } from "../hooks/use-packages";
import { useAllSchedules } from "../hooks/use-schedules";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { detailElsewhere, isUnreadableHere } from "../lib/detail-elsewhere";
import { ResourceErrorState } from "./page-states";

type DetailKind = "agent" | "skill" | "integration" | "schedule";

interface UnreadableDetailProps {
  kind: DetailKind;
  id: string;
  error: unknown;
  /** Drawn while the spanning list answers: the page's own skeleton. */
  pending: ReactNode;
  /** The hint out of the mode (the page's own wording); in it, the hint naming no space. */
  hint?: ReactNode;
  children?: ReactNode;
}

export function UnreadableDetail(props: UnreadableDetailProps) {
  const { on } = useOverviewMode();
  if (!on || !isUnreadableHere(props.error)) {
    return (
      <ResourceErrorState error={props.error} hint={props.hint}>
        {props.children}
      </ResourceErrorState>
    );
  }
  if (props.kind === "agent") return <AgentElsewhere {...props} />;
  if (props.kind === "schedule") return <ScheduleElsewhere {...props} />;
  return <PackageElsewhere {...props} type={props.kind} />;
}

function AgentElsewhere(props: UnreadableDetailProps) {
  const { data, isError } = useAgents({ spanning: true });
  return (
    <Elsewhere
      {...props}
      rows={data?.map((row) => ({ id: row.id, spaceIds: row.space_ids }))}
      failed={isError}
    />
  );
}

function PackageElsewhere(props: UnreadableDetailProps & { type: "skill" | "integration" }) {
  const { data, isError } = usePackageList(props.type, true);
  return (
    <Elsewhere
      {...props}
      rows={data?.map((row) => ({ id: row.id, spaceIds: row.space_ids }))}
      failed={isError}
    />
  );
}

function ScheduleElsewhere(props: UnreadableDetailProps) {
  const { data, isError } = useAllSchedules(true);
  return (
    <Elsewhere
      {...props}
      rows={data?.map((row) => ({ id: row.id, spaceIds: [row.spaceId] }))}
      failed={isError}
    />
  );
}

function Elsewhere({
  id,
  error,
  pending,
  children,
  rows,
  failed,
}: UnreadableDetailProps & {
  rows: { id: string; spaceIds: readonly string[] }[] | undefined;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const { pathname, hash } = useLocation();
  const currentSpaceId = useCurrentSpaceId();
  // A list that failed proves nothing: the page says what it read.
  const to = detailElsewhere(failed ? [] : rows, id, pathname, currentSpaceId);
  if (to === undefined) return <>{pending}</>;
  if (to !== null) return <Navigate to={`${to}${hash}`} replace />;
  return (
    <ResourceErrorState error={error} hint={t("error.resourceUnavailableHintAcross")}>
      {children}
    </ResourceErrorState>
  );
}
