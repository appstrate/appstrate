import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
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
          <button type="button" onClick={onClose}>
            {t("btn.cancel")}
          </button>
          <button className="primary" type="submit" form="proxy-form" disabled={isPending}>
            {isPending ? <Spinner /> : t("btn.save")}
          </button>
        </>
      }
    >
      <form id="proxy-form" onSubmit={handleSubmit} className="provider-form">
        <div className="form-group">
          <label htmlFor="px-label">{t("proxies.modal.label")}</label>
          <input
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
            className={errors.label ? "input-error" : undefined}
          />
          {errors.label && <div className="field-error">{errors.label}</div>}
        </div>
        <div className="form-group">
          <label htmlFor="px-url">{t("proxies.modal.url")}</label>
          <input
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
            className={errors.url ? "input-error" : undefined}
          />
          {proxy && <div className="hint">{t("proxies.modal.urlHint")}</div>}
          {errors.url && <div className="field-error">{errors.url}</div>}
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
