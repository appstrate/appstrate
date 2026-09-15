// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import type { PackageType } from "@appstrate/core/validation";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { useSpaces } from "../../hooks/use-spaces";
import { useMovePackageHome } from "../../hooks/use-packages";
import { writableDestinations } from "../../lib/package-home";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Move a package's home space — the counterpart of `PATCH
 * /api/packages/{scope}/{name}`, and the only way out of the 409 a space
 * deletion answers when it still homes packages.
 */
export function MoveHomeSpaceDialog({
  open,
  onClose,
  packageId,
  type,
  homeSpaceId,
}: {
  open: boolean;
  onClose: () => void;
  packageId: string;
  type: PackageType;
  homeSpaceId: string | null | undefined;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: spaces } = useSpaces(open);
  const move = useMovePackageHome(type);
  const [target, setTarget] = useState("");

  const writable = writableDestinations(spaces, type, homeSpaceId);

  // The dialog stays mounted between openings, so the selection is cleared on
  // the way OUT — every exit goes through here (cancel, Esc, overlay, success).
  const close = () => {
    setTarget("");
    onClose();
  };

  const submit = () => {
    const destination = writable.find((space) => space.id === target);
    if (!destination) return;
    move.mutate(
      { id: packageId, homeSpaceId: destination.id },
      {
        onSuccess: () => {
          toast.success(t("packages.moveHomeDone", { space: destination.name }));
          close();
        },
        onError: (error) => toast.error(getErrorMessage(error)),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("packages.moveHomeTitle")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={close}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button type="button" onClick={submit} disabled={!target || move.isPending}>
            {move.isPending ? <Spinner /> : t("packages.moveHomeSubmit")}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="move-home-space">{t("packages.moveHomeLabel")}</Label>
        <Select value={target || undefined} onValueChange={setTarget}>
          <SelectTrigger id="move-home-space" className="w-full">
            <SelectValue placeholder={t("packages.moveHomePlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {writable.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-sm">
          {writable.length === 0 ? t("packages.moveHomeEmpty") : t("packages.moveHomeHint")}
        </p>
      </div>
    </Modal>
  );
}
