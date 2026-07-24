// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { artifactFailureCodeKey, partialArtifactFailures } from "./run-artifacts";

/**
 * Banner shown on the run-detail page when the run's outputs sweep ended
 * `partial` — one or more deliverables were LOST (upload abandoned after
 * retries, or a file over the per-file cap). The run itself may well have
 * SUCCEEDED (artifacts status is independent of run status), so this is the only
 * place a finished, green run surfaces the silent data loss. Lists each lost
 * file's name with a human explanation of its failure code.
 */
export function RunArtifactsBanner({ artifacts }: { artifacts: unknown }) {
  const { t } = useTranslation("agents");
  const failures = partialArtifactFailures(artifacts);
  if (!failures || failures.length === 0) return null;
  return (
    <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-4" />
        {t("run.artifacts.partial.title")}
      </div>
      <p className="text-muted-foreground mt-1">{t("run.artifacts.partial.message")}</p>
      <ul className="mt-2 space-y-1.5">
        {failures.map((f) => (
          <li key={f.name} className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs break-all">{f.name}</span>
            <span className="text-muted-foreground shrink-0">
              {t(artifactFailureCodeKey(f.code))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
