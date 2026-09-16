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
import { Checkbox } from "@appstrate/ui/components/checkbox";
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
  // Checked by default: that is what the move has always done, so opening this
  // dialog and pressing Move changes nothing about what the space being left
  // runs. Unchecking is the deliberate act, not the default one.
  const [keepInPreviousHome, setKeepInPreviousHome] = useState(true);

  const writable = writableDestinations(spaces, type, homeSpaceId);
  // The space being LEFT, named so the checkbox can say which one it is about.
  // `home_space_id` is null when the caller cannot reach that space — but the
  // move requires `<type>:write` THERE, so a caller who got this far can.
  const previousHome = spaces?.find((space) => space.id === homeSpaceId);

  // The dialog stays mounted between openings, so the selection is cleared on
  // the way OUT — every exit goes through here (cancel, Esc, overlay, success).
  const close = () => {
    setTarget("");
    setKeepInPreviousHome(true);
    onClose();
  };

  const submit = () => {
    const destination = writable.find((space) => space.id === target);
    if (!destination) return;
    move.mutate(
      { id: packageId, homeSpaceId: destination.id, keepInPreviousHome },
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
      {/*
        The half of the act the word "move" does not carry: the space being
        LEFT keeps the package unless this is unchecked. Rendered whether or
        not that space currently runs it, because the answer is the same either
        way — a dialog that appeared only for an activated package would put
        the old asymmetry back where the user cannot see it.
      */}
      {previousHome ? (
        <div className="mt-4 flex gap-3">
          <Checkbox
            id="move-home-keep"
            className="mt-0.5"
            checked={keepInPreviousHome}
            onCheckedChange={(checked) => setKeepInPreviousHome(checked === true)}
          />
          <div className="space-y-1">
            <Label htmlFor="move-home-keep" className="font-normal">
              {t("packages.moveHomeKeep", { space: previousHome.name })}
            </Label>
            <p className="text-muted-foreground text-sm">
              {keepInPreviousHome
                ? t("packages.moveHomeKeepHint", { space: previousHome.name })
                : t("packages.moveHomeReleaseHint", { space: previousHome.name })}
            </p>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
