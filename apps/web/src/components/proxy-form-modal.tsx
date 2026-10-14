// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useAppForm } from "../hooks/use-app-form";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { FormItem } from "@appstrate/ui/components/field";
import { Input } from "@appstrate/ui/components/input";
import type { OrgProxyInfo } from "../hooks/use-proxies";

interface ProxyFormModalProps {
  open: boolean;
  onClose: () => void;
  proxy: OrgProxyInfo | null;
  isPending: boolean;
  onSubmit: (data: { label: string; url: string }) => void;
}

type ProxyFormData = {
  label: string;
  url: string;
};

function ProxyFormBody({
  proxy,
  isPending,
  onSubmit,
  onClose,
}: {
  proxy: OrgProxyInfo | null;
  isPending: boolean;
  onSubmit: (data: { label: string; url: string }) => void;
  onClose: () => void;
}) {
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

  const title = proxy ? t("proxies.modal.editTitle") : t("proxies.modal.createTitle");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit" form="proxy-form" disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save")}
          </Button>
        </>
      }
    >
      <form id="proxy-form" onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
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
      </form>
    </Modal>
  );
}

export function ProxyFormModal({ open, onClose, proxy, isPending, onSubmit }: ProxyFormModalProps) {
  if (!open) return null;

  // Key forces remount when proxy changes, resetting all state
  const key = proxy?.id ?? "__create__";

  return (
    <ProxyFormBody
      key={key}
      proxy={proxy}
      isPending={isPending}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  );
}
