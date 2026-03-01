import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";

interface ServiceStatus {
  id: string;
  connectionMode?: string;
  status: string;
  adminProvided?: boolean;
}

interface ShareDropdownProps {
  packageId: string;
  isAdmin: boolean;
  services: ServiceStatus[];
}

export function ShareDropdown({ packageId, isAdmin, services }: ShareDropdownProps) {
  const { t } = useTranslation(["flows", "common"]);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const copyLink = () => {
    const url = `${window.location.origin}/flows/${packageId}/run`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setOpen(false);
    });
  };

  // Check if the flow can be shared publicly:
  // All services must be admin-mode and connected
  const canSharePublic =
    services.length === 0 ||
    services.every(
      (s) =>
        (s.connectionMode ?? "user") === "admin" && s.adminProvided && s.status === "connected",
    );

  const hasUserModeServices = services.some((s) => (s.connectionMode ?? "user") === "user");

  const generateShareLink = async () => {
    setGenerating(true);
    try {
      const data = await api<{ token: string }>(`/flows/${packageId}/share-token`, {
        method: "POST",
      });
      const url = `${window.location.origin}/share/${data.token}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : t("share.errorGenerate"));
    } finally {
      setGenerating(false);
    }
  };

  // Non-admin: simple button
  if (!isAdmin) {
    return (
      <button onClick={copyLink} title={t("share.copyLinkTitle")}>
        {copied ? t("share.copied") : t("share.share")}
      </button>
    );
  }

  // Admin: dropdown with two options
  return (
    <div className="share-dropdown" ref={ref}>
      <button onClick={() => setOpen(!open)} title={t("share.optionsTitle")}>
        {copied ? t("share.copied") : t("share.share")}
      </button>
      {open && (
        <div className="share-dropdown-menu">
          <button className="share-dropdown-item" onClick={copyLink}>
            {t("share.copyLink")}
          </button>
          <button
            className="share-dropdown-item"
            onClick={generateShareLink}
            disabled={!canSharePublic || generating}
            title={
              hasUserModeServices
                ? t("share.cantShareUserMode")
                : !canSharePublic
                  ? t("share.cantShareNotConnected")
                  : t("share.generatePublicLink")
            }
          >
            {generating ? t("share.generating") : t("share.publicLink")}
          </button>
        </div>
      )}
    </div>
  );
}
