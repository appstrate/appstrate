// SPDX-License-Identifier: Apache-2.0

/**
 * A published version beside the package's stored draft. The version is the
 * value of the modal's query parameter; both sides are read here, so the diff
 * never depends on what the page holding the modal happens to have loaded.
 */
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import type { useModalParam } from "../../hooks/use-modal-param";
import { usePackageDetail, useVersionDetail } from "../../hooks/use-packages";
import { DiffTab } from "../diff-tab";
import { Modal } from "../modal";
import { TextSkeleton } from "../loading-skeletons";

export function CompareWithDraftModal({
  type,
  packageId,
  compare,
}: {
  type: PackageType;
  packageId: string;
  compare: ReturnType<typeof useModalParam>;
}) {
  const { t } = useTranslation("agents");
  const version = compare.value ?? undefined;
  const { data: draft } = usePackageDetail(type, version && packageId);
  const { data: compared } = useVersionDetail(type, packageId, version);

  return (
    <Modal
      open={version !== undefined}
      onClose={compare.close}
      title={t("detail.files.compareTitle", { version })}
      className="max-w-5xl"
    >
      {draft && compared ? (
        <DiffTab
          type={type}
          latestVersion={compared}
          currentManifest={draft.manifest}
          currentContent={
            "prompt" in draft ? draft.prompt : "content" in draft ? draft.content : null
          }
        />
      ) : (
        <TextSkeleton lines={8} />
      )}
    </Modal>
  );
}
