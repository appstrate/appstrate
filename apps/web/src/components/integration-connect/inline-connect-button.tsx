// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldsConnectModal } from "./fields-connect-modal";
import { useIntegrationOAuthPopup } from "./use-integration-oauth-popup";
import { useIntegrationDetail } from "../../hooks/use-integrations";

/**
 * Agent-driven inline connect/upgrade trigger. Picks the right surface
 * based on the auth type — OAuth popup vs api_key/basic/custom fields
 * modal — and forwards the agent's per-tool scope inference to the
 * kickoff so the consent prompt asks for exactly what's needed.
 *
 * Used by:
 *   - AgentIntegrationsBlock (Connexions tab status cards)
 *   - MissingConnectionsModal (412 recovery surface)
 *
 * On success the integration's React Query keys are invalidated by the
 * underlying mutation hooks; the consuming card/row re-renders with
 * the new status.
 */

interface InlineConnectButtonProps {
  packageId: string;
  authKey: string;
  /**
   * Scopes inferred from the agent's `tools[]` selection. Forwarded
   * verbatim to the OAuth kickoff so the consent prompt asks for the
   * minimum the agent needs (backend still unions with defaults +
   * already-granted for incremental consent).
   */
  scopes?: string[];
  /** "Connect" vs "Fix" copy — same wire action, different intent. */
  intent: "connect" | "fix";
  size?: "sm" | "default";
  /** Override button label entirely. */
  label?: string;
}

export function InlineConnectButton({
  packageId,
  authKey,
  scopes,
  intent,
  size = "sm",
  label,
}: InlineConnectButtonProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: detail } = useIntegrationDetail(packageId);
  const { openPopup, isPending } = useIntegrationOAuthPopup();
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const auth = detail?.manifest?.auths?.[authKey];
  const isOAuth = auth?.type === "oauth2";
  const displayName = detail?.manifest.displayName ?? packageId;

  // Guard: a fresh agent run might 412 before the integration manifest
  // is in cache. Disable the button until the detail loads rather than
  // popping a modal with no auth metadata.
  const disabled = !auth || isPending;

  const onClick = () => {
    if (!auth) return;
    if (isOAuth) {
      void openPopup({ packageId, authKey, ...(scopes ? { scopes } : {}) });
    } else {
      setFieldsOpen(true);
    }
  };

  const text =
    label ?? (intent === "fix" ? t("detail.integrationFix") : t("detail.integrationConnect"));

  const Icon = intent === "fix" ? RefreshCw : Plug;

  return (
    <>
      <Button
        size={size}
        onClick={onClick}
        disabled={disabled}
        data-testid={`inline-connect-${packageId}-${authKey}`}
      >
        <Icon className="mr-1 size-3" />
        {text}
      </Button>
      {auth && !isOAuth && (
        <FieldsConnectModal
          open={fieldsOpen}
          onClose={() => setFieldsOpen(false)}
          packageId={packageId}
          authKey={authKey}
          auth={auth}
          displayName={displayName}
        />
      )}
    </>
  );
}
