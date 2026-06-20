// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { TestResult } from "@appstrate/shared-types";

/**
 * Inline connection-test result — green latency on success, red message on
 * failure. Shared by every "test this credential/model/proxy" surface so the
 * success/failure rendering never forks. The caller supplies the i18n keys for
 * its own namespace (`{ latency }` / `{ message }` interpolation).
 */
export function TestResultSpan({
  result,
  successKey,
  failedKey,
}: {
  result: TestResult;
  successKey: string;
  failedKey: string;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <span className={`text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}>
      {result.ok
        ? t(successKey, { latency: result.latency })
        : t(failedKey, { message: result.message })}
    </span>
  );
}
