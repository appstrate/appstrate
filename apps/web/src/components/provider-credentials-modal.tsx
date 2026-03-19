import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { ProviderCredentialsForm } from "./provider-credentials-form";
import type { ProviderConfig } from "@appstrate/shared-types";

interface ProviderCredentialsModalProps {
  provider: ProviderConfig;
  callbackUrl?: string;
  onClose: () => void;
}

export function ProviderCredentialsModal({
  provider,
  callbackUrl,
  onClose,
}: ProviderCredentialsModalProps) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("providers.form.title.configure") + " — " + provider.displayName}
    >
      <ProviderCredentialsForm
        provider={provider}
        callbackUrl={callbackUrl}
        onSuccess={onClose}
        footer={
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common:btn.cancel")}
          </Button>
        }
      />
    </Modal>
  );
}
