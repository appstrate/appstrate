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
import { ShareLinkModal } from "./share-link-modal";

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
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const copyLink = () => {
    setShareUrl(`${window.location.origin}/flows/${packageId}/run`);
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
      setShareUrl(`${window.location.origin}/share/${data.token}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : t("share.errorGenerate"));
    } finally {
      setGenerating(false);
    }
  };

  // Non-admin: simple button
  if (!isAdmin) {
    return (
      <>
        <Button variant="outline" onClick={copyLink} title={t("share.copyLinkTitle")}>
          {t("share.share")}
        </Button>
        <ShareLinkModal open={!!shareUrl} onClose={() => setShareUrl(null)} url={shareUrl ?? ""} />
      </>
    );
  }

  // Admin: dropdown with two options
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" title={t("share.optionsTitle")}>
            {t("share.share")}
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
      <ShareLinkModal open={!!shareUrl} onClose={() => setShareUrl(null)} url={shareUrl ?? ""} />
    </>
  );
}
