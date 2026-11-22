// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { useFirstRunsPage } from "../hooks/use-paginated-runs";

/**
 * The runs the space filter hides, when some are in flight or unread: the sidebar counts every
 * space, so a narrowed list must not leave that count unexplained. Nothing while loading or at 0.
 */
export function HiddenRunsNotice({
  hiddenIds,
  showAll,
}: {
  hiddenIds: readonly string[];
  showAll: () => void;
}) {
  const { t } = useTranslation("agents");
  const enabled = hiddenIds.length > 0;
  const inFlight =
    useFirstRunsPage({
      spanning: true,
      spaceIds: hiddenIds,
      status: ["pending", "running"],
      limit: 1,
      enabled,
    }).data?.total ?? 0;
  const unread =
    useFirstRunsPage({ spanning: true, spaceIds: hiddenIds, unread: true, limit: 1, enabled }).data
      ?.total ?? 0;

  if (!enabled || (inFlight === 0 && unread === 0)) return null;

  const inFlightText = t("runs.hidden.inFlight", { count: inFlight });
  const unreadText = t("runs.hidden.unread", { count: unread });
  const summary =
    inFlight > 0 && unread > 0
      ? t("runs.hidden.both", { inFlight: inFlightText, unread: unreadText })
      : inFlight > 0
        ? inFlightText
        : unreadText;

  return (
    <Alert
      variant="info"
      className="mb-3"
      action={
        <Button variant="outline" size="sm" onClick={showAll}>
          {t("runs.hidden.show")}
        </Button>
      }
    >
      <AlertDescription>{t("runs.hidden.notice", { summary })}</AlertDescription>
    </Alert>
  );
}
