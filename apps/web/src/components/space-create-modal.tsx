// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { cn } from "@appstrate/ui/cn";
import { Modal } from "./modal";
import { useModalParam } from "../hooks/use-modal-param";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Spinner } from "./spinner";
import { useCreateSpace } from "../hooks/use-spaces";
import { errorMessage } from "../lib/mutation-error";

/** The URL parameter that opens the modal. */
export const NEW_SPACE_PARAM = "newSpace";

type FormData = { name: string };

export function SpaceCreateModal() {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateSpace();
  const param = useModalParam(NEW_SPACE_PARAM);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    showError,
    formState: { errors },
  } = useAppForm<FormData>({ defaultValues: { name: "" } });

  const handleClose = () => {
    reset({ name: "" });
    createMutation.reset();
    param.close();
  };

  const onFormSubmit = (data: FormData) => {
    createMutation.mutate(
      { body: { name: data.name.trim() } },
      {
        onSuccess: () => handleClose(),
        onError: (err) => {
          setError("root", { message: errorMessage(err) });
        },
      },
    );
  };

  if (param.value === null) return null;

  return (
    <Modal
      open
      onClose={handleClose}
      title={t("spaces.createTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={handleClose}>
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
        <div className="space-y-2">
          <Label htmlFor="space-create-name">{t("spaces.nameLabel")}</Label>
          <Input
            id="space-create-name"
            type="text"
            placeholder={t("spaces.namePlaceholder")}
            autoFocus
            aria-invalid={showError("name") ? true : undefined}
            className={cn(showError("name") && "border-destructive")}
            {...register("name", {
              required: t("validation.required", { ns: "common" }),
            })}
          />
          {showError("name") && (
            <div className="text-destructive text-sm">{errors.name?.message}</div>
          )}
        </div>
        {errors.root?.message && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
