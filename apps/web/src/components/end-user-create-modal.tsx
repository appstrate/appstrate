// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useCreateEndUser } from "../hooks/use-end-users";

interface Props {
  open: boolean;
  onClose: () => void;
}

type FormData = {
  name: string;
  email: string;
  externalId: string;
};

export function EndUserCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateEndUser();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: "", email: "", externalId: "" },
  });

  const handleClose = () => {
    reset({ name: "", email: "", externalId: "" });
    createMutation.reset();
    onClose();
  };

  const onFormSubmit = (data: FormData) => {
    const payload: Record<string, string> = {};
    if (data.name.trim()) payload.name = data.name.trim();
    if (data.email.trim()) payload.email = data.email.trim();
    if (data.externalId.trim()) payload.externalId = data.externalId.trim();

    createMutation.mutate(payload, {
      onSuccess: () => handleClose(),
      onError: (err) => {
        setError("root", { message: err instanceof Error ? err.message : String(err) });
      },
    });
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("applications.createEndUserTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={handleClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="create-end-user-form" disabled={createMutation.isPending}>
            {createMutation.isPending ? <Spinner /> : t("btn.create")}
          </Button>
        </>
      }
    >
      <form id="create-end-user-form" onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="eu-name">{t("applications.endUserName")}</Label>
          <Input
            id="eu-name"
            type="text"
            placeholder={t("applications.endUserNamePlaceholder")}
            autoFocus
            {...register("name")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="eu-email">{t("applications.endUserEmail")}</Label>
          <Input
            id="eu-email"
            type="email"
            placeholder="alice@example.com"
            {...register("email")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="eu-external-id">{t("applications.endUserExternalId")}</Label>
          <Input
            id="eu-external-id"
            type="text"
            placeholder="my_user_123"
            {...register("externalId")}
          />
        </div>
        {errors.root?.message && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
