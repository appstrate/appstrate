// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { OptionSelect } from "@/components/app-ui/option-select";
import { CheckboxField } from "@/components/app-ui/checkbox-field";
import { FormItem } from "@/components/app-ui/form-item";
import type { PackageType } from "@appstrate/core/validation";
import { FormModal } from "../form-modal";
import { spaceLabel } from "../../lib/space-label";
import { useSpaces } from "../../hooks/use-spaces";
import { useMovePackageHome } from "../../hooks/use-packages";
import { writableDestinations } from "../../lib/package-home";

/** The URL parameter that opens the dialog; its value is the package. */
export const MOVE_HOME_PARAM = "moveHome";

/** `PUT /api/packages/{scope}/{name}/home`; the only way out of the 409 a space deletion answers while it homes packages. */
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
  // Checked by default: pressing Move alone changes nothing about what the space being left runs.
  const [keepInPreviousHome, setKeepInPreviousHome] = useState(true);

  const writable = writableDestinations(spaces, type, homeSpaceId);
  // The space being LEFT; `home_space_id` is null only when unreachable, which the move's `<type>:write` there rules out.
  const previousHome = spaces?.find((space) => space.id === homeSpaceId);

  // The dialog stays mounted between openings, so every exit clears the selection.
  const close = () => {
    setTarget("");
    setKeepInPreviousHome(true);
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
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
    <FormModal
      onClose={close}
      onSubmit={submit}
      title={t("packages.moveHomeTitle")}
      isPending={move.isPending}
      submitLabel={t("packages.moveHomeSubmit")}
      submitDisabled={!target}
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
      {previousHome ? (
        <CheckboxField
          id="move-home-keep"
          className="mt-4"
          label={t("packages.moveHomeKeep", { space: spaceLabel(previousHome, t) })}
          description={
            keepInPreviousHome
              ? t("packages.moveHomeKeepHint", { space: spaceLabel(previousHome, t) })
              : t("packages.moveHomeReleaseHint", { space: spaceLabel(previousHome, t) })
          }
          checked={keepInPreviousHome}
          onCheckedChange={(checked) => setKeepInPreviousHome(checked === true)}
        />
      ) : null}
    </FormModal>
  );
}
