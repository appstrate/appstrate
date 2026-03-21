import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OrgProxyInfo } from "@appstrate/shared-types";

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
    formState: { errors },
  } = useForm<ProxyFormData>({
    defaultValues: { label: proxy?.label ?? "", url: "" },
    mode: "onBlur",
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
        <div className="space-y-2">
          <Label htmlFor="px-label">{t("proxies.modal.label")}</Label>
          <Input
            id="px-label"
            type="text"
            placeholder={t("proxies.modal.labelPlaceholder")}
            autoFocus
            aria-invalid={errors.label ? true : undefined}
            className={cn(errors.label && "border-destructive")}
            {...register("label", {
              required: t("validation.required", { ns: "common" }),
            })}
          />
          {errors.label && <div className="text-sm text-destructive">{errors.label.message}</div>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="px-url">{t("proxies.modal.url")}</Label>
          <Input
            id="px-url"
            type="text"
            placeholder={t("proxies.modal.urlPlaceholder")}
            aria-invalid={errors.url ? true : undefined}
            className={cn(errors.url && "border-destructive")}
            {...register("url", {
              validate: (v) => {
                if (!proxy && !v.trim()) return t("validation.required", { ns: "common" });
                return true;
              },
            })}
          />
          {proxy && (
            <div className="text-sm text-muted-foreground">{t("proxies.modal.urlHint")}</div>
          )}
          {errors.url && <div className="text-sm text-destructive">{errors.url.message}</div>}
        </div>
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
