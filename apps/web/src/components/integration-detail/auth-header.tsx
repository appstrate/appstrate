// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { IntegrationAuthStatus } from "../../hooks/use-integrations";

// ─────────────────────────────────────────────
// Auth header (shared chrome for both tabs)
// ─────────────────────────────────────────────

/** Auth identity row reused by the Connexions and Configuration blocks. */
export function AuthHeader({ status }: { status: IntegrationAuthStatus }) {
  const { t } = useTranslation("settings");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <ShieldCheck size={16} className="text-muted-foreground" />
      <span className="font-mono text-sm font-semibold">{status.auth_key}</span>
      <Badge variant="outline">{status.type}</Badge>
      {status.required ? (
        <Badge variant="default">{t("integration.auth.required")}</Badge>
      ) : (
        <Badge variant="secondary">{t("integration.auth.optional")}</Badge>
      )}
    </div>
  );
}
