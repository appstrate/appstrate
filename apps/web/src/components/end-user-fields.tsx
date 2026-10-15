// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { RowsEditor } from "./rows-editor";
import type { MetadataEntry } from "../lib/end-user-metadata";

export interface EndUserFormValues {
  name: string;
  email: string;
  externalId: string;
  metadata: MetadataEntry[];
}

/** The end-user fields, shared by the create and edit forms. */
export function EndUserFields({
  values,
  onChange,
}: {
  values: EndUserFormValues;
  onChange: (values: EndUserFormValues) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <>
      <FormItem id="eu-name" label={t("spaces.nameLabel")}>
        <Input
          type="text"
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          placeholder={t("spaces.endUserNamePlaceholder")}
          autoFocus
        />
      </FormItem>
      <FormItem id="eu-email" label={t("login.email")}>
        <Input
          type="email"
          value={values.email}
          onChange={(e) => onChange({ ...values, email: e.target.value })}
          placeholder="alice@example.com"
        />
      </FormItem>
      <FormItem id="eu-external-id" label={t("spaces.endUserExternalId")}>
        <Input
          type="text"
          value={values.externalId}
          onChange={(e) => onChange({ ...values, externalId: e.target.value })}
          placeholder="my_user_123"
        />
      </FormItem>
      <RowsEditor
        label={t("spaces.metadata")}
        rows={values.metadata}
        onChange={(metadata) => onChange({ ...values, metadata })}
        newRow={{ key: "", value: "" }}
        addLabel={t("spaces.addMetadataKey")}
        renderRow={(entry, update) => (
          <>
            <Input
              value={entry.key}
              onChange={(e) => update({ ...entry, key: e.target.value })}
              placeholder={t("spaces.metadataKey")}
              aria-label={t("spaces.metadataKey")}
              className="flex-1"
            />
            <Input
              value={entry.value}
              onChange={(e) => update({ ...entry, value: e.target.value })}
              placeholder={t("spaces.metadataValue")}
              aria-label={t("spaces.metadataValue")}
              className="flex-1"
            />
          </>
        )}
      />
    </>
  );
}
