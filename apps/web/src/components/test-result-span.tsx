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
  const message = result.ok
    ? t(successKey, { latency: result.latency })
    : t(failedKey, { message: result.message });
  return (
    // Truncating, and titled: this sits in an actions cell beside buttons, and
    // a failure message is as long as the server made it. Left to grow it
    // squeezed the controls it is reporting on.
    <span
      className={`min-w-0 truncate text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}
      title={message}
    >
      {message}
    </span>
  );
}
