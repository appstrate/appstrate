// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";

/** A destructive alert naming a failed read, with a Retry button. */
export function RetryAlert({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  const { t } = useTranslation("common");
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>
        <p>{message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("btn.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
