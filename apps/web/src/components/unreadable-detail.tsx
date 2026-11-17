// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page whose resource the working space cannot read. Out of « Tous les espaces » it says
 * so (`ResourceErrorState`). In the mode the working space is hidden: the page looks the resource
 * up once across the reader's spaces and reopens in the space holding it, its query and hash kept,
 * and only says it is unavailable when no reached space does — without naming « cet espace ». The
 * look-up is a one-off read: once it has answered, nothing polls.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { $api } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useOrgScope } from "../hooks/use-org-scope";
import { fetchSchedules } from "../hooks/use-schedules";
import { useCurrentOrgId } from "../hooks/use-org";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useSpaces } from "../hooks/use-spaces";
import { useRowSpaceGrants } from "../hooks/use-permissions";
import { ACROSS_SPACES, scheduleKeys } from "../lib/query-keys";
import { detailElsewhere, isUnreadableHere } from "../lib/detail-elsewhere";
import { isSpaceEnterable } from "../lib/space-lists";
import { ResourceErrorState } from "./page-states";

type DetailKind = "agent" | "skill" | "integration" | "schedule" | "run" | "notification";

interface UnreadableDetailProps {
  kind: DetailKind;
  id: string;
  error: unknown;
  /** A version needs full content access; agents:run grants only the live summary. */
  version?: boolean;
  /** Drawn while the read across spaces answers: the page's own skeleton. */
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
  if (props.kind === "schedule") return <ScheduleElsewhere {...props} />;
  if (props.kind === "run" || props.kind === "notification") return <RowElsewhere {...props} />;
  return <PackageElsewhere {...props} />;
}

/** The home lookup shares the detail's sight and placement rules, including inactive homes. */
function PackageElsewhere(props: UnreadableDetailProps) {
  const scope = useOrgScope();
  const grants = useRowSpaceGrants();
  const { data, isError } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/home",
    {
      params: { path: splitPackageRef(props.id), header: scope.header },
    },
    { enabled: scope.enabled },
  );
  const spaceIds =
    !isError && data?.type === props.kind
      ? data.read_space_ids.filter((id) => !props.version || grants(id, `${data.type}s:read`))
      : [];
  return <Elsewhere {...props} loading={!data && !isError} spaceIds={spaceIds} />;
}

function ScheduleElsewhere(props: UnreadableDetailProps) {
  const orgId = useCurrentOrgId();
  // The spanning list's cache, read without its polling: this observer sets no interval.
  const { data, isError } = useQuery({
    queryKey: scheduleKeys.list(orgId, ACROSS_SPACES),
    queryFn: () => fetchSchedules(orgId),
    enabled: !!orgId,
  });
  const row = data?.find((schedule) => schedule.id === props.id);
  return (
    <Elsewhere
      {...props}
      loading={!data && !isError}
      spaceIds={!isError && row ? [row.spaceId] : []}
    />
  );
}

function RowElsewhere(props: UnreadableDetailProps) {
  const orgId = useCurrentOrgId();
  const { data, isPending } = $api.useQuery(
    "get",
    props.kind === "run" ? "/api/orgs/{orgId}/runs/{id}" : "/api/orgs/{orgId}/notifications/{id}",
    { params: { path: { orgId: orgId ?? "", id: props.id } } },
    { enabled: !!orgId && !!props.id },
  );
  return <Elsewhere {...props} loading={isPending} spaceIds={data ? [data.spaceId] : []} />;
}

function Elsewhere({
  error,
  pending,
  children,
  loading,
  spaceIds,
}: UnreadableDetailProps & { loading: boolean; spaceIds: readonly string[] }) {
  const { t } = useTranslation();
  const { pathname, search, hash } = useLocation();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const enterable = (spaceId: string) =>
    !!spaces?.some((space) => space.id === spaceId && isSpaceEnterable(space));
  if (loading) return <>{pending}</>;
  const to = detailElsewhere(spaceIds, `${pathname}${search}${hash}`, currentSpaceId, enterable);
  if (to !== null) return <Navigate to={to} replace />;
  return (
    <ResourceErrorState error={error} hint={t("error.resourceUnavailableHintAcross")}>
      {children}
    </ResourceErrorState>
  );
}
