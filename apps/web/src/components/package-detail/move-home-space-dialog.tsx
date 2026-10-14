// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { OptionSelect } from "@appstrate/ui/components/select";
import { Button } from "@appstrate/ui/components/button";
import { CheckboxField } from "@appstrate/ui/components/checkbox";
import { FormItem } from "@appstrate/ui/components/field";
import type { PackageType } from "@appstrate/core/validation";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { useSpaces } from "../../hooks/use-spaces";
import { useMovePackageHome } from "../../hooks/use-packages";
import { writableDestinations } from "../../lib/package-home";

/** The URL parameter that opens the dialog; its value is the package. */
export const MOVE_HOME_PARAM = "moveHome";

/**
 * Move a package's home space — the counterpart of `PUT
 * /api/packages/{scope}/{name}/home`, and the only way out of the 409 a space
 * deletion answers when it still homes packages.
 */
export function MoveHomeSpaceDialog({
  onClose,
  packageId,
  type,
  homeSpaceId,
}: {
  onClose: () => void;
  packageId: string;
  type: PackageType;
  homeSpaceId: string | null | undefined;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { data: spaces } = useSpaces();
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
      },
    );
  };

  return (
    <Modal
      open
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
      <FormItem
        id="move-home-space"
        label={t("packages.moveHomeLabel")}
        hint={writable.length === 0 ? t("packages.moveHomeEmpty") : t("packages.moveHomeHint")}
      >
        <OptionSelect
          value={target || undefined}
          onValueChange={setTarget}
          placeholder={t("packages.moveHomePlaceholder")}
          className="w-full"
          options={writable.map((space) => ({ value: space.id, label: space.name }))}
        />
      </FormItem>
      {/*
        The half of the act the word "move" does not carry: the space being
        LEFT keeps the package unless this is unchecked. Rendered whether or
        not that space currently runs it, because the answer is the same either
        way — a dialog that appeared only for an activated package would put
        the old asymmetry back where the user cannot see it.
      */}
      {previousHome ? (
        <CheckboxField
          id="move-home-keep"
          className="mt-4"
          label={t("packages.moveHomeKeep", { space: previousHome.name })}
          description={
            keepInPreviousHome
              ? t("packages.moveHomeKeepHint", { space: previousHome.name })
              : t("packages.moveHomeReleaseHint", { space: previousHome.name })
          }
          checked={keepInPreviousHome}
          onCheckedChange={(checked) => setKeepInPreviousHome(checked === true)}
        />
      ) : null}
    </Modal>
  );
}
