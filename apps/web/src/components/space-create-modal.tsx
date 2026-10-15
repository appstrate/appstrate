// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { FormModal } from "./form-modal";
import { useModalParam } from "../hooks/use-modal-param";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { useCreateSpace } from "../hooks/use-spaces";
import { errorMessage } from "../lib/mutation-error";

/** The URL parameter that opens the modal. */
export const NEW_SPACE_PARAM = "newSpace";

type FormData = { name: string };

export function SpaceCreateModal() {
  const param = useModalParam(NEW_SPACE_PARAM);
  // The form exists only while the modal is open, so any way of closing it (Annuler, a click
  // outside, Escape, Back) abandons what was typed.
  if (param.value === null) return null;
  return <SpaceCreateForm onClose={param.close} />;
}

function SpaceCreateForm({ onClose }: { onClose: () => void }) {
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
