import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

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
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);

  const copyLink = () => {
    const url = `${window.location.origin}/flows/${packageId}/run`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
    } catch (err) {
      alert(err instanceof Error ? err.message : t("share.errorGenerate"));
    } finally {
      setGenerating(false);
    }
  };

  // Non-admin: simple button
  if (!isAdmin) {
    return (
      <Button variant="outline" onClick={copyLink} title={t("share.copyLinkTitle")}>
        {copied ? t("share.copied") : t("share.share")}
      </Button>
    );
  }

  // Admin: dropdown with two options
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" title={t("share.optionsTitle")}>
          {copied ? t("share.copied") : t("share.share")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink}>{t("share.copyLink")}</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={generateShareLink}
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
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
