import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/invite/${token}`;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? t("btn.copied") : t("btn.copyLink")}
    </Button>
  );
}
