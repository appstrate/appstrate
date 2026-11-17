// SPDX-License-Identifier: Apache-2.0

/**
 * What a notification says and where it leads — read by the bell's rows and by
 * the notification's own page, so both tell it the same way.
 *
 * One rule decides where a click goes, and the page it opens is the one that
 * marks the notification read: a failed run opens the run (the run page reads
 * its failure notice), every other kind opens `/notifications/:id` (that page
 * reads it). A failed run whose page is closed to the caller opens the
 * notification's page too, so no notification is left without a page to read
 * it on.
 */

import type { TFunction } from "i18next";
import type { paths } from "../api/client";
import { catalogueHref } from "./catalogue-link";
import { formatDateField } from "./format-date";

/** One notification as returned by `GET /api/notifications/{id}` (a row of the feed has the same shape). */
export type NotificationItem =
  paths["/api/notifications/{id}"]["get"]["responses"]["200"]["content"]["application/json"];

export interface NotificationView {
  title: string;
  /** A failed run's status. */
  status: string | null;
  /** The text an agent sent (`agent_message`). */
  message: string | null;
  /** The line under the title: its date, and who sent it for an agent's message. */
  meta: string;
  /** The run the notification is about, when it names one. */
  runHref: string | null;
  /** The shared package's sheet (`package_shared`). */
  packageHref: string | null;
}

function notificationPageHref(notificationId: string): string {
  return `/notifications/${encodeURIComponent(notificationId)}`;
}

export function describeNotification(
  notification: NotificationItem,
  agentName: (packageId: string) => string | undefined,
  t: TFunction<["common", "agents"]>,
): NotificationView {
  const date = formatDateField(notification.createdAt);
  if (notification.type === "package_shared") {
    const share = notification.payload;
    return {
      title: t("notifications.packageShared", {
        name: share?.shared_by_name ?? "",
        package: share?.packageId ?? "",
      }),
      status: null,
      message: null,
      meta: date,
      runHref: null,
      // One share, one decision: THAT package's sheet, not a list to search.
      packageHref: share ? catalogueHref(share.package_type, { packageId: share.packageId }) : null,
    };
  }
  const packageId = notification.payload?.packageId ?? null;
  const runHref =
    packageId && notification.runId ? `/agents/${packageId}/runs/${notification.runId}` : null;
  // Live name, else the one stamped on the run (agent switched off or deleted).
  const agent =
    (packageId ? agentName(packageId) : undefined) ??
    notification.payload?.agent_name ??
    packageId ??
    t("runs.deletedAgent", { ns: "agents" });
  if (notification.type === "agent_message") {
    // A message the agent sent from its run (`notify`): its own title and text, no status.
    const sent = notification.payload;
    return {
      title: sent?.title ?? agent,
      status: null,
      message: sent?.message ?? null,
      meta: t("notifications.agentMessageFrom", { agent, date }),
      runHref,
      packageHref: null,
    };
  }
  // A run that needs attention: it failed or timed out.
  return {
    title: agent,
    status: notification.payload?.status ?? null,
    message: null,
    meta: date,
    runHref,
    packageHref: null,
  };
}

/** Where a click on the notification goes — the page that will mark it read. */
export function notificationTarget(
  notification: NotificationItem,
  view: NotificationView,
  canReach: (target: string) => boolean,
): string {
  if (notification.type === "run_failed" && view.runHref && canReach(view.runHref)) {
    return view.runHref;
  }
  return notificationPageHref(notification.id);
}
