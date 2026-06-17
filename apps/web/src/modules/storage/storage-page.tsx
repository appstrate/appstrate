// SPDX-License-Identifier: Apache-2.0

// Shell wrapper for the storage module page — the feature UI lives in the
// module package (`@appstrate/module-storage/ui`); this wrapper adds the app
// chrome (PageHeader) and injects host capabilities the package can't import:
// org/app scoping headers, and the native integration OAuth popup so a Drive
// disk can connect/upgrade a connection in place (no module-side OAuth).
// Lazy-loaded behind `features.storage`.

import { useTranslation } from "react-i18next";
import { StoragePage } from "@appstrate/module-storage/ui";
import { getAuthHeaders } from "../../lib/scoping-headers";
import { PageHeader } from "@/components/page-header";
import { useIntegrationOAuthPopup } from "@/components/integration-connect/use-integration-oauth-popup";

export function StorageModulePage() {
  const { t } = useTranslation("common");
  const { openPopup } = useIntegrationOAuthPopup();
  return (
    <div className="p-6">
      <PageHeader
        title={t("nav.storage")}
        emoji="🗄️"
        breadcrumbs={[{ label: t("nav.orgSection"), href: "/" }, { label: t("nav.storage") }]}
      />
      <StoragePage getHeaders={getAuthHeaders} connectIntegration={openPopup} />
    </div>
  );
}
