// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import { Spinner } from "./spinner";
import { useCreateEndUser } from "../hooks/use-end-users";
import { errorMessage } from "../lib/mutation-error";
import { EndUserMetadataEditor } from "./end-user-metadata-editor";
import { entriesToMetadata, type MetadataEntry } from "../lib/end-user-metadata";

interface Props {
  onClose: () => void;
}

type FormData = {
  name: string;
  email: string;
  externalId: string;
};

/** Mounted only while open: any way of closing it (Annuler, outside, Escape, Back) abandons the input. */
export function EndUserCreateModal({ onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateEndUser();
  const [metadata, setMetadata] = useState<MetadataEntry[]>([]);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: "", email: "", externalId: "" },
  });

  const onFormSubmit = (data: FormData) => {
    const payload: NonNullable<Parameters<typeof createMutation.mutate>[0]["body"]> = {};
    if (data.name.trim()) payload.name = data.name.trim();
    if (data.email.trim()) payload.email = data.email.trim();
    if (data.externalId.trim()) payload.externalId = data.externalId.trim();
    const meta = entriesToMetadata(metadata);
    if (Object.keys(meta).length > 0) payload.metadata = meta;

    createMutation.mutate(
      { body: payload },
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
      title={t("spaces.createEndUserTitle")}
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
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
          <Label htmlFor="eu-name">{t("spaces.endUserName")}</Label>
          <Input
            id="eu-name"
            type="text"
            placeholder={t("spaces.endUserNamePlaceholder")}
            autoFocus
            {...register("name")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="eu-email">{t("spaces.endUserEmail")}</Label>
          <Input
            id="eu-email"
            type="email"
            placeholder="alice@example.com"
            {...register("email")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="eu-external-id">{t("spaces.endUserExternalId")}</Label>
          <Input
            id="eu-external-id"
            type="text"
            placeholder="my_user_123"
            {...register("externalId")}
          />
        </div>
        <EndUserMetadataEditor entries={metadata} onChange={setMetadata} />
        {errors.root?.message && <p className="text-destructive text-sm">{errors.root.message}</p>}
      </form>
    </Modal>
  );
}
