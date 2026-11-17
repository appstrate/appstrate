// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "./form-modal";
import { useCreateEndUser } from "../hooks/use-end-users";
import { errorMessage } from "../lib/mutation-error";
import { EndUserFields, type EndUserFormValues } from "./end-user-fields";
import { entriesToMetadata } from "../lib/end-user-metadata";

interface Props {
  onClose: () => void;
}

/** Mounted only while open: any way of closing it (Annuler, outside, Escape, Back) abandons the input. */
export function EndUserCreateModal({ onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateEndUser();
  const [values, setValues] = useState<EndUserFormValues>({
    name: "",
    email: "",
    externalId: "",
    metadata: [],
  });
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const payload: NonNullable<Parameters<typeof createMutation.mutate>[0]["body"]> = {};
    if (values.name.trim()) payload.name = values.name.trim();
    if (values.email.trim()) payload.email = values.email.trim();
    if (values.externalId.trim()) payload.externalId = values.externalId.trim();
    const meta = entriesToMetadata(values.metadata);
    if (Object.keys(meta).length > 0) payload.metadata = meta;

    createMutation.mutate(
      { body: payload },
      { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <FormModal
      onClose={onClose}
      title={t("spaces.newEndUser")}
      onSubmit={onSubmit}
      isPending={createMutation.isPending}
      submitLabel={t("btn.create")}
      error={error}
    >
      <EndUserFields values={values} onChange={setValues} />
    </FormModal>
  );
}
