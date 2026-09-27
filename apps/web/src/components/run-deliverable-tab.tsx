// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/errors";
import { useFile } from "../hooks/use-files";
import { FileArtifact } from "./file-artifact";

export function RunDeliverableTab({
  fileId,
  onUnavailable,
}: {
  fileId: string;
  onUnavailable: (fileId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { data, isLoading, error } = useFile(fileId);

  useEffect(() => {
    // A background refresh may retain usable data alongside a transient error;
    // only reconcile the run pointer when the authoritative API says the file
    // no longer exists. Network/5xx failures must not hide a valid deliverable
    // while the platform is temporarily unavailable.
    if (error instanceof ApiError && error.status === 404 && !data) {
      onUnavailable(fileId);
    }
  }, [data, fileId, error, onUnavailable]);

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
