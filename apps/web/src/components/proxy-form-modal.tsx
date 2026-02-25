import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    if (!proxy && !url.trim()) return;
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
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("proxies.modal.labelPlaceholder")}
            required
            autoFocus
          />
        </div>
        <div className="form-group">
          <label htmlFor="px-url">{t("proxies.modal.url")}</label>
          <input
            id="px-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("proxies.modal.urlPlaceholder")}
            required={!proxy}
          />
          {proxy && <div className="hint">{t("proxies.modal.urlHint")}</div>}
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
