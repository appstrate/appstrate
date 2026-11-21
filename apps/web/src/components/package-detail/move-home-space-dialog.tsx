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
import { previousHomeSchedules, writableDestinations } from "../../lib/package-home";
import { useSchedules } from "../../hooks/use-schedules";
import { useRowSpaceGrants } from "../../hooks/use-permissions";
import { errorMessage } from "../../lib/mutation-error";

/** What the move does to the schedules of the space being left; follows the "keep" checkbox live. */
export function PreviousHomeSchedules({
  state,
  keep,
  space,
}: {
  state: ReturnType<typeof previousHomeSchedules> | null;
  keep: boolean;
  space: string;
}) {
  const { t } = useTranslation("settings");
  if (state === null) return null;
  let text: string;
  if (state === "unknown") {
    text = keep
      ? t("packages.moveHomeSchedulesKeptUnknown", { space })
      : t("packages.moveHomeSchedulesDisabledUnknown", { space });
  } else if (state === 0) {
    text = t("packages.moveHomeSchedulesNone", { space });
  } else {
    text = keep
      ? t("packages.moveHomeSchedulesKept", { count: state, space })
      : t("packages.moveHomeSchedulesDisabled", { count: state, space });
  }
  return <p className="text-muted-foreground mt-2 text-xs tabular-nums">{text}</p>;
}

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

  // Only agents have schedules; counting them needs `schedules:read` in the space being left.
  const grants = useRowSpaceGrants();
  const readable = grants(homeSpaceId ?? undefined, "schedules:read");
  const countable = type === "agent" && !!previousHome;
  const schedules = useSchedules(countable && readable ? packageId : undefined, {
    spanning: true,
  });
  const schedulesState =
    countable && previousHome
      ? previousHomeSchedules(schedules.data, previousHome.id, {
          readable,
          isError: schedules.isError,
        })
      : null;
  const destination = writable.find((space) => space.id === target);

  // The dialog stays mounted between openings, so every exit clears the selection.
  const close = () => {
    setTarget("");
    setKeepInPreviousHome(true);
    move.reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
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
      error={move.error ? errorMessage(move.error) : null}
      submitLabel={t("packages.moveHomeSubmit")}
      submitDisabled={!target}
    >
      <FormItem
        id="move-home-space"
        label={t("packages.moveHomeLabel")}
        hint={
          writable.length === 0
            ? t("packages.moveHomeEmpty")
            : destination
              ? t("packages.moveHomePublisher", { space: destination.name })
              : t("packages.moveHomeHint")
        }
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
        <>
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
          <PreviousHomeSchedules
            state={schedulesState}
            keep={keepInPreviousHome}
            space={spaceLabel(previousHome, t)}
          />
        </>
      ) : null}
    </FormModal>
  );
}
