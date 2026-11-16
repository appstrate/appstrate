// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Modal } from "./modal";
import { SpaceName } from "./space-name";

interface PickableSpace {
  id: string;
  personal: boolean;
  name: string;
  icon: string | null;
  color: string | null;
  orphaned_at?: string | null;
}

/**
 * « Dans quel espace ? »: the one question an action naming no space asks in « Vue d'ensemble »,
 * when several spaces may take it (`useSpaceAction`). One click picks.
 */
export function SpacePickerModal({
  spaces,
  onPick,
  onClose,
}: {
  spaces: readonly PickableSpace[];
  onPick: (spaceId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <Modal
      onClose={onClose}
      title={t("spacePicker.title")}
      description={t("spacePicker.description")}
      className="sm:max-w-sm"
    >
      <SpacePickerList spaces={spaces} onPick={onPick} />
    </Modal>
  );
}

/** The modal's body, apart so a test renders it (portals render nothing there). */
export function SpacePickerList({
  spaces,
  onPick,
}: {
  spaces: readonly PickableSpace[];
  onPick: (spaceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {spaces.map((space) => (
        <Button
          key={space.id}
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start gap-3 px-2 py-2"
          onClick={() => onPick(space.id)}
        >
          <SpaceName space={space} size="md" />
        </Button>
      ))}
    </div>
  );
}
