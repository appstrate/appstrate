// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { TestResult } from "@appstrate/shared-types";
import { refusalMessage } from "../lib/mutation-error";

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
  const { t } = useTranslation(["settings", "common"]);
  const accepted =
    result.ok && result.status !== undefined && (result.status < 200 || result.status > 299);
  // The outcome is named by its code, as a sentence of its own; a code with no sentence
  // keeps the server's message behind the caller's "Échec :" lead.
  const failure = result.error
    ? refusalMessage({ code: result.error, message: result.message })
    : null;
  const message = accepted
    ? t("test.acceptedWithStatus", { ns: "common", status: result.status, latency: result.latency })
    : result.ok
      ? t(successKey, { latency: result.latency })
      : (failure ?? t(failedKey, { message: result.message }));
  const tone = accepted ? "text-warning" : result.ok ? "text-green-500" : "text-destructive";
  return (
    // Truncating, and titled: this sits in an actions cell beside buttons, and
    // a failure message is as long as the server made it. Left to grow it
    // squeezed the controls it is reporting on.
    <span className={`min-w-0 truncate text-sm ${tone}`} title={message}>
      {message}
    </span>
  );
}
