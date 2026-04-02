// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useCreateApplication } from "../hooks/use-applications";

interface Props {
  open: boolean;
  onClose: () => void;
}

type FormData = { name: string };

export function ApplicationCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApplication();

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
    onClose();
  };

  const onFormSubmit = (data: FormData) => {
    createMutation.mutate(
      { name: data.name.trim() },
      {
        onSuccess: () => handleClose(),
        onError: (err) => {
          setError("root", { message: err instanceof Error ? err.message : String(err) });
        },
      },
    );
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("applications.createTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={handleClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="create-application-form" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("btn.create")}
          </Button>
        </>
      }
    >
      <form
        id="create-application-form"
        onSubmit={handleSubmit(onFormSubmit)}
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="app-create-name">{t("applications.nameLabel")}</Label>
          <Input
            id="app-create-name"
            type="text"
            placeholder={t("applications.namePlaceholder")}
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
