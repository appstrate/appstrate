// SPDX-License-Identifier: Apache-2.0

/**
 * A published version beside the package's stored draft. The version is the
 * value of the modal's query parameter; the draft is read here, and so is the
 * version unless the page already holds it as `latestVersion`.
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
  latestVersion,
}: {
  type: PackageType;
  packageId: string;
  compare: ReturnType<typeof useModalParam>;
  /** The latest version when the page already holds it: comparing it reads nothing more. */
  latestVersion?: ReturnType<typeof useVersionDetail>["data"];
}) {
  const { t } = useTranslation("agents");
  const version = compare.value ?? undefined;
  const { data: draft } = usePackageDetail(type, version && packageId);
  const isLatest = version !== undefined && latestVersion?.version === version;
  const { data: fetched } = useVersionDetail(type, packageId, isLatest ? undefined : version);
  const compared = isLatest ? latestVersion : fetched;

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
