// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderCredentialsModal } from "./provider-credentials-modal";
import type { ProviderConfig } from "@appstrate/shared-types";

export function ProviderConfigureButton({
  provider,
  callbackUrl,
}: {
  provider: ProviderConfig;
  callbackUrl?: string;
}) {
  const { t } = useTranslation("flows");
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <Settings size={14} className="mr-1" />
        {t("detail.configure", { defaultValue: "Configure" })}
      </Button>
      {open && (
        <ProviderCredentialsModal
          provider={provider}
          callbackUrl={callbackUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
