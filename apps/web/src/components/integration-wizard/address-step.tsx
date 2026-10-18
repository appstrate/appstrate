// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import { FormItem } from "@/components/app-ui/form-item";
import { PendingButton } from "@/components/app-ui/pending-button";
import { errorMessage } from "../../lib/mutation-error";
import { WizardSection } from "./wizard-section";

/** The server's address: analysed on « Continuer » only, never while it is typed. */
export function AddressStep({
  url,
  onUrlChange,
  onSubmit,
  pending,
  disabled = false,
  error,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  onSubmit: () => void;
  pending: boolean;
  /** The address is no longer the user's to change (a creation is in flight). */
  disabled?: boolean;
  error: unknown;
}) {
  const { t } = useTranslation("agents");
  return (
    <WizardSection
      title={t("integrationWizard.address.title")}
      description={t("integrationWizard.address.description")}
      focus={false}
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() && !disabled) onSubmit();
        }}
      >
        <FormItem
          id="integration-wizard-url"
          label={t("integrationWizard.address.label")}
          className="min-w-0 flex-1"
          error={error != null ? errorMessage(error) : undefined}
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            disabled={disabled}
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder={t("integrationWizard.address.placeholder")}
          />
        </FormItem>
        <PendingButton
          type="submit"
          pending={pending}
          disabled={disabled || !url.trim()}
          className="sm:mt-6"
        >
          {t("integrationWizard.address.submit")}
        </PendingButton>
      </form>
      {/* The spinner says it on screen; this says it to a screen reader. */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? t("integrationWizard.address.analysing") : ""}
      </p>
    </WizardSection>
  );
}
