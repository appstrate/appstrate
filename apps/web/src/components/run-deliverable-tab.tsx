// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useFile } from "../hooks/use-files";
import { FileArtifact } from "./file-artifact";

export function RunDeliverableTab({ fileId }: { fileId: string }) {
  const { t } = useTranslation("agents");
  const { data, isLoading, error } = useFile(fileId);

  return (
    <section aria-label={t("run.deliverableLabel")} className="min-w-0">
      <FileArtifact
        fileId={fileId}
        file={data}
        isLoading={isLoading}
        error={error}
        className="h-[max(28rem,calc(100vh-20rem))]"
      />
    </section>
  );
}
