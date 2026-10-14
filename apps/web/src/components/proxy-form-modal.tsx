// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { FormModal } from "./form-modal";
import { FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import type { OrgProxyInfo } from "../hooks/use-proxies";

interface ProxyFormModalProps {
  onClose: () => void;
  proxy: OrgProxyInfo | null;
  isPending: boolean;
  onSubmit: (data: { label: string; url: string }) => void;
}

type ProxyFormData = {
  label: string;
  url: string;
};

/** Mounted by the caller while open, one per proxy (`key`): closing abandons the input. */
export function ProxyFormModal({ onClose, proxy, isPending, onSubmit }: ProxyFormModalProps) {
  const { t } = useTranslation(["settings", "common"]);

  const {
    register,
    handleSubmit,
    showError,
    formState: { errors },
  } = useAppForm<ProxyFormData>({
    defaultValues: { label: proxy?.label ?? "", url: "" },
  });

  const onFormSubmit = (data: ProxyFormData) => {
    onSubmit({
      label: data.label.trim(),
      url: data.url.trim(),
    });
  };

  return (
    <FormModal
      onClose={onClose}
      title={proxy ? t("proxies.modal.editTitle") : t("proxies.modal.createTitle")}
      onSubmit={handleSubmit(onFormSubmit)}
      isPending={isPending}
    >
      <FormItem
        id="px-label"
        label={t("proxies.modal.label")}
        error={showError("label") ? errors.label?.message : undefined}
      >
        <Input
          type="text"
          placeholder={t("proxies.modal.labelPlaceholder")}
          autoFocus
          {...register("label", {
            required: t("validation.required", { ns: "common" }),
          })}
        />
      </FormItem>
      <FormItem
        id="px-url"
        label={t("proxies.modal.url")}
        hint={proxy ? t("proxies.modal.urlHint") : undefined}
        error={showError("url") ? errors.url?.message : undefined}
      >
        <Input
          type="text"
          placeholder={t("proxies.modal.urlPlaceholder")}
          {...register("url", {
            validate: (v) => {
              if (!proxy && !v.trim()) return t("validation.required", { ns: "common" });
              return true;
            },
          })}
        />
      </FormItem>
    </FormModal>
  );
}
