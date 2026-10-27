// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { useTestModel, type OrgModelInfo } from "../../hooks/use-models";
import { ModelTestResult } from "./model-test-result";

/**
 * A saved model's own deeds, at the start of its form's footer: delete it, test it. A model left
 * to each member has no key of the organization's to test (`model_credential_required`).
 */
export function SavedModelActions({
  model,
  onDelete,
}: {
  model: OrgModelInfo;
  /** Absent when the caller may not delete models (`models:delete`). */
  onDelete?: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { testingIds, testResults, handleTest } = useConnectionTest(useTestModel());
  const testable = model.credentialId !== null;
  const testing = testingIds.has(model.id);
  const result = testResults[model.id];

  if (!testable && !onDelete) return null;
  return (
    <div className="mr-auto flex min-w-0 items-center gap-2">
      {onDelete && (
        <Button type="button" variant="outline" className="text-destructive" onClick={onDelete}>
          {t("btn.delete", { ns: "common" })}
        </Button>
      )}
      {testable && (
        <PendingButton
          type="button"
          variant="outline"
          onClick={() => void handleTest(model.id)}
          pending={testing}
        >
          {t("models.test")}
        </PendingButton>
      )}
      {result && <ModelTestResult result={result} />}
    </div>
  );
}
