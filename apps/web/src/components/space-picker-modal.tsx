// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { Modal } from "./modal";
import { useViewer } from "../hooks/use-auth";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

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
  const { t } = useTranslation(["common", "settings"]);
  const viewer = useViewer();
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
          <IdentityTile {...spaceTile(space, viewer)} className="size-7 rounded-md" />
          <span className="truncate">{spaceLabel(space, t)}</span>
        </Button>
      ))}
    </div>
  );
}
