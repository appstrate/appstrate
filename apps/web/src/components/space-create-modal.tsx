// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { Modal } from "./modal";
import { useModalParam } from "../hooks/use-modal-param";
import { Button } from "@appstrate/ui/components/button";
import { FieldError, FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import { Spinner } from "./spinner";
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
    <Modal
      open
      onClose={onClose}
      title={t("spaces.createTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button
            type="submit"
            form="create-space-form"
            data-testid="space-create-submit"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? <Spinner /> : t("btn.create")}
          </Button>
        </>
      }
    >
      <form id="create-space-form" onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
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
        <FieldError>{errors.root?.message}</FieldError>
      </form>
    </Modal>
  );
}
