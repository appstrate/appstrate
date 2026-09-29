// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";

/** Drops a stored connection pick — in the picker under a lock that outranks it, and on a schedule. */
export function ClearChoiceButton({ onClick, testId }: { onClick: () => void; testId?: string }) {
  const { t } = useTranslation(["agents"]);
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick} data-testid={testId}>
      {t("schedule.connectionOverrides.clearChoice")}
    </Button>
  );
}
