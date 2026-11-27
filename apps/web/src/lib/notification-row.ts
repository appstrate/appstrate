// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import { formatDateField } from "./format-date";
import { catalogueHref } from "./catalogue-link";
import { packageDetailPath, runDetailPath } from "./package-paths";
import { integrationSettingsHref } from "./settings-section-href";
import { linkedSpacePath } from "./across-spaces";
import type { paths } from "../api/client";

/** One notification as returned by `GET /api/notifications`. */
export type NotificationItem =
  paths["/api/notifications"]["get"]["responses"]["200"]["content"]["application/json"]["data"][number];

/** The preferences page listing the caller's own connections, where one is reconnected. */
const RECONNECT_PATH = "/preferences/connections";

/** What a row says and where it leads (`null` when that page is closed to the caller). */
interface NotificationRow {
  title: string;
  status: string | null;
  /** The text an agent sent (`agent_message`). */
  message: string | null;
  /** The line under the row: its date, and who sent it for an agent's message. */
  meta: string;
  target: string | null;
  /** The locale key of the button leading to `target`. */
  targetLabel: string;
}

/**
 * One row per kind — the notification's page reads it too. Notifications follow
 * the session's ceiling, not the space's reads, so each target is asked of `canReach`.
 */
export function notificationRow(
  notification: NotificationItem,
  agentName: (packageId: string) => string | undefined,
  canReach: (target: string) => boolean,
  t: TFunction<["common", "agents"]>,
): NotificationRow {
  const date = formatDateField(notification.createdAt);
  if (notification.type === "package_shared") {
    // One share, one decision: open THAT package's sheet, not a list to search.
    const share = notification.payload;
    const href = share ? catalogueHref(share.package_type, { packageId: share.packageId }) : null;
    return {
      title: t("notifications.packageShared", {
        name: share?.shared_by_name ?? "",
        package: share?.packageId ?? "",
      }),
      status: null,
      message: null,
      meta: date,
      target: href && canReach(href) ? href : null,
      targetLabel: "notifications.openPackage",
    };
  }
  if (notification.type === "credential_needs_reconnection") {
    // The owner's own connections: where a dead connection is reconnected.
    const dead = notification.payload;
    return {
      title: t("notifications.credentialNeedsReconnection", {
        label: dead?.label ?? "",
        integration: dead?.integration_name ?? "",
      }),
      status: null,
      message: dead ? t(`notifications.credentialCause.${dead.cause}`) : null,
      meta: date,
      target: canReach(RECONNECT_PATH) ? RECONNECT_PATH : null,
      targetLabel: "notifications.reconnect",
    };
  }
  if (notification.type === "connection_scopes_requested") {
    // The owner's own connections: the row offers to reconnect it with what was asked for.
    const asked = notification.payload;
    return {
      title: t("notifications.connectionScopesRequested", {
        label: asked?.label ?? "",
        integration: asked?.integration_name ?? "",
      }),
      status: null,
      message: t("notifications.connectionScopesRequestedHint"),
      meta: date,
      target: canReach(RECONNECT_PATH) ? RECONNECT_PATH : null,
      targetLabel: "notifications.grantScopes",
    };
  }
  if (notification.type === "integration_tools_review") {
    // The tools wait in the integration's Outils section, where they are settled.
    const review = notification.payload;
    const href = review
      ? integrationSettingsHref(packageDetailPath("integration", review.packageId), "tools")
      : null;
    return {
      title: t("notifications.integrationToolsReview", {
        name: review?.display_name ?? review?.packageId ?? "",
      }),
      status: null,
      message: null,
      meta: date,
      target: href && canReach(href) ? href : null,
      targetLabel: "notifications.reviewTools",
    };
  }
  const packageId = notification.payload?.packageId ?? null;
  const href =
    packageId && notification.runId ? runDetailPath(packageId, notification.runId) : null;
  const target = href && canReach(href) ? href : null;
  const liveName = packageId ? agentName(packageId) : undefined;
  if (notification.type === "agent_message") {
    // A message the agent sent from its run (`notify`): its own title and text, no status.
    const sent = notification.payload;
    const agent =
      liveName ?? sent?.agent_name ?? packageId ?? t("runs.deletedAgent", { ns: "agents" });
    return {
      title: sent?.title ?? agent,
      status: null,
      message: sent?.message ?? null,
      meta: t("notifications.agentMessageFrom", { agent, date }),
      target,
      targetLabel: "notifications.openRun",
    };
  }
  // A run that needs attention: it failed or timed out.
  return {
    // Live name, else the one stamped on the run (agent switched off or deleted).
    title:
      liveName ??
      notification.payload?.agent_name ??
      packageId ??
      t("runs.deletedAgent", { ns: "agents" }),
    status: notification.payload?.status ?? null,
    message: null,
    meta: date,
    target,
    targetLabel: "notifications.openRun",
  };
}

/**
 * Where a row leads, in the notification's own space: a failed run opens its run, every other
 * kind its own page; either reads it. Another space's is entered on the way (`?enterSpace=`).
 */
export function notificationHref(
  notification: NotificationItem,
  target: string | null,
  currentSpaceId: string | null,
): string {
  const path =
    notification.type === "run_failed" && target ? target : `/notifications/${notification.id}`;
  return linkedSpacePath(path, notification.spaceId, currentSpaceId);
}
