import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFormErrors } from "../hooks/use-form-errors";
import type { OrgProxyInfo } from "@appstrate/shared-types";

interface ProxyFormModalProps {
  open: boolean;
  onClose: () => void;
  proxy: OrgProxyInfo | null;
  isPending: boolean;
  onSubmit: (data: { label: string; url: string }) => void;
}

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
  const [label, setLabel] = useState(proxy?.label ?? "");
  const [url, setUrl] = useState("");

  const rules = useMemo(
    () => ({
      label: (v: string) => {
        if (!v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
      url: (v: string) => {
        if (!proxy && !v.trim()) return t("validation.required", { ns: "common" });
        return undefined;
      },
    }),
    [t, proxy],
  );

  const { errors, onBlur, validateAll, clearField } = useFormErrors(rules);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateAll({ label, url })) return;

    onSubmit({
      label: label.trim(),
      ...(url.trim() ? { url: url.trim() } : {}),
    } as { label: string; url: string });
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
      <form id="proxy-form" onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="px-label">{t("proxies.modal.label")}</Label>
          <Input
            id="px-label"
            type="text"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              clearField("label");
            }}
            onBlur={() => onBlur("label", label)}
            placeholder={t("proxies.modal.labelPlaceholder")}
            autoFocus
            aria-invalid={errors.label ? true : undefined}
            className={cn(errors.label && "border-destructive")}
          />
          {errors.label && <div className="text-sm text-destructive">{errors.label}</div>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="px-url">{t("proxies.modal.url")}</Label>
          <Input
            id="px-url"
            type="text"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              clearField("url");
            }}
            onBlur={() => onBlur("url", url)}
            placeholder={t("proxies.modal.urlPlaceholder")}
            aria-invalid={errors.url ? true : undefined}
            className={cn(errors.url && "border-destructive")}
          />
          {proxy && (
            <div className="text-sm text-muted-foreground">{t("proxies.modal.urlHint")}</div>
          )}
          {errors.url && <div className="text-sm text-destructive">{errors.url}</div>}
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
