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
  if (result.ok && result.status !== undefined && (result.status < 200 || result.status > 299)) {
    return (
      <span className="text-warning text-sm">
        {t("test.acceptedWithStatus", {
          ns: "common",
          status: result.status,
          latency: result.latency,
        })}
      </span>
    );
  }
  // The outcome is named by its code, as a sentence of its own; a code with no sentence
  // keeps the server's message behind the caller's "Échec :" lead.
  const failure = result.error
    ? refusalMessage({ code: result.error, message: result.message })
    : null;
  return (
    <span className={`text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}>
      {result.ok
        ? t(successKey, { latency: result.latency })
        : (failure ?? t(failedKey, { message: result.message }))}
    </span>
  );
}
