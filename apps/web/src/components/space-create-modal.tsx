// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { FormModal } from "./form-modal";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { useCreateSpace } from "../hooks/use-spaces";
import { errorMessage } from "../lib/mutation-error";

/** Opened from the organization switcher as well as from the spaces page. */
export const NEW_SPACE_PARAM = "newSpace";

type FormData = { name: string };

export function SpaceCreateModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateSpace();

  const {
    register,
    handleSubmit,
    setError,
    showError,
    formState: { errors },
  } = useAppForm<FormData>({ defaultValues: { name: "" } });

  const onFormSubmit = (data: FormData) => {
    createMutation.mutate(
      { body: { name: data.name.trim() } },
      {
        onSuccess: onClose,
        onError: (err) => {
          setError("root", { message: errorMessage(err) });
        },
      },
    );
  };

  return (
    <FormModal
      onClose={onClose}
      title={t("spaces.create")}
      onSubmit={handleSubmit(onFormSubmit)}
      isPending={createMutation.isPending}
      submitLabel={t("btn.create")}
      submitTestId="space-create-submit"
      error={errors.root?.message}
    >
      <FormItem
        id="space-create-name"
        label={t("spaces.nameLabel")}
        error={showError("name") ? errors.name?.message : undefined}
      >
        <Input
          type="text"
          placeholder={t("spaces.namePlaceholder")}
          autoFocus
          {...register("name", {
            required: t("validation.required", { ns: "common" }),
          })}
        />
      </FormItem>
    </FormModal>
  );
}
