// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";

/**
 * The runs the space filter hides, when some are in flight or unread: the sidebar counts every
 * space, so a narrowed list must not leave that count unexplained. Nothing at 0.
 */
export function HiddenRunsNotice({
  inFlight,
  unread,
  showAll,
}: {
  inFlight: number;
  unread: number;
  showAll: () => void;
}) {
  const { t } = useTranslation("agents");
  if (inFlight === 0 && unread === 0) return null;

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
