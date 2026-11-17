// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { TestResult } from "@appstrate/shared-types";
import { TestResultSpan } from "../test-result-span";

/**
 * A model's connection-test result. The generic sentence for `NEEDS_RECONNECTION` words an
 * integration connection and its owner; a model's key is neither. A success says what the
 * test checked: the credential, never the model itself (`testModelConfig`).
 */
export function ModelTestResult({ result }: { result: TestResult }) {
  const { t } = useTranslation("settings");
  if (!result.ok && result.error === "NEEDS_RECONNECTION") {
    return (
      <span className="text-destructive text-sm">{t("models.credentialUnavailableHint")}</span>
    );
  }
  return (
    <TestResultSpan
      result={result}
      successKey="models.testSuccess"
      failedKey="credentials.testFailed"
    />
  );
}
