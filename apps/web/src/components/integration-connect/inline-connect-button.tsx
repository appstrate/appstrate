// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Plug, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldsConnectModal } from "./fields-connect-modal";
import { useIntegrationOAuthPopup } from "./use-integration-oauth-popup";
import { useIntegrationDetail } from "../../hooks/use-integrations";

/**
 * Agent-driven inline connect/upgrade trigger.
 *
 * Mono-auth integrations (Gmail, ClickUp): single button — primary click
 * routes to the OAuth popup or the credentials modal based on auth type.
 *
 * Multi-auth integrations (GitHub: oauth + pat): same primary button
 * with a chevron that opens a dropdown listing every declared auth so
 * the user picks which method to connect with. Labels come from i18n
 * keyed on `auth.type` (`oauth2` → "OAuth", `api_key` → "Clé API", …) —
 * no per-integration label boilerplate, generic across the catalog.
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
  /**
   * Default authKey for the primary click action. When the integration
   * declares multiple auths, the dropdown lets the user override.
   */
  authKey: string;
  /**
   * Scopes inferred from the agent's `tools[]` selection. Forwarded
   * verbatim to the OAuth kickoff so the consent prompt asks for the
   * minimum the agent needs. The backend requests `defaults ∪ these ∪
   * what the target connection already granted` — it does NOT walk
   * installed agents, so omitting this (e.g. the integration page's "+
   * Add account") connects with the manifest defaults only. Scope
   * upgrades pass the missing scopes here explicitly.
   */
  scopes?: string[];
  /**
   * `connect` — first connection (no row yet).
   * `reconnect` — connection exists but `needsReconnection=true`; user
   *   re-runs the full OAuth dance, the upstream row is preserved
   *   (upsert keyed by `(integration, authKey, accountId, app, owner)`).
   * `upgrade` — connection exists with valid tokens but the agent's
   *   selected tools require scopes the actor hasn't granted yet; OAuth
   *   re-kickoff requests defaults + missing + already-granted so the
   *   IdP shows an incremental-consent screen for the diff only.
   */
  intent: "connect" | "reconnect" | "upgrade";
  size?: "sm" | "default";
  /** Override button label entirely. */
  label?: string;
  /**
   * Force the OAuth IdP to render its account picker (via
   * `prompt=select_account`). Used on "add another" CTAs so the user
   * can actually authenticate as a different upstream account; without
   * it the IdP silently reuses the signed-in session.
   */
  forceAccountSelect?: boolean;
  /**
   * Existing connection id to UPDATE in place (reconnect / upgrade).
   * Omitted on fresh-connect CTAs — the callback then INSERTs a new
   * row. Threaded all the way through the OAuth state record.
   */
  connectionId?: string;
  /**
   * Force the primary single-button path bound to `authKey`, suppressing
   * the multi-auth method-picker dropdown. Used on the integration detail
   * page, where the button lives *inside* a per-auth section that already
   * represents one method — offering the other methods there is nonsense.
   */
  lockToAuthKey?: boolean;
  /**
   * Fired after a connect/renew attempt resolves (OAuth popup closed or a
   * fields connect succeeded). The OAuth popup can't distinguish success from
   * a user cancel, so consumers should treat this as "re-read the truth"
   * (e.g. refetch) rather than an assertion of success.
   */
  onConnected?: () => void;
}

export function InlineConnectButton({
  packageId,
  authKey: defaultAuthKey,
  scopes,
  intent,
  size = "sm",
  label,
  forceAccountSelect,
  connectionId,
  lockToAuthKey,
  onConnected,
}: InlineConnectButtonProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: detail } = useIntegrationDetail(packageId);
  const { openPopup, isPending } = useIntegrationOAuthPopup();
  // When set, the credentials modal renders for that authKey. Unifies
  // the single-auth and multi-auth paths — both eventually call
  // setFieldsAuthKey(key) for non-oauth types.
  const [fieldsAuthKey, setFieldsAuthKey] = useState<string | null>(null);

  const auths = detail?.manifest?.auths ?? {};
  const authKeys = Object.keys(auths);
  // The method-picker dropdown only makes sense when one button stands in
  // for the whole integration. When the button is locked to a section's
  // authKey, render the single-button path bound to that method.
  const showDropdown = authKeys.length > 1 && !lockToAuthKey;
  const displayName = detail?.manifest.display_name ?? packageId;

  // Guard: a fresh agent run might 412 before the integration manifest
  // is in cache. Disable the trigger until the detail loads rather than
  // popping a modal with no auth metadata.
  const disabled = authKeys.length === 0 || isPending;

  const triggerConnect = (key: string) => {
    const auth = auths[key];
    if (!auth) return;
    if (auth.type === "oauth2") {
      void openPopup({
        packageId,
        authKey: key,
        ...(scopes ? { scopes } : {}),
        ...(forceAccountSelect ? { forceAccountSelect: true } : {}),
        ...(connectionId ? { connectionId } : {}),
      })
        .then(() => onConnected?.())
        .catch(() => {});
    } else {
      setFieldsAuthKey(key);
    }
  };

  const text =
    label ??
    (intent === "upgrade"
      ? t("detail.integrationUpgrade")
      : intent === "reconnect"
        ? t("detail.integrationReconnect")
        : t("detail.integrationConnect"));
  const Icon = intent === "connect" ? Plug : RefreshCw;
  const tooltip = intent === "upgrade" ? t("detail.integrationUpgradeTooltip") : undefined;
  const fieldsAuth = fieldsAuthKey ? auths[fieldsAuthKey] : null;

  return (
    <>
      {showDropdown ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size={size}
              disabled={disabled}
              data-testid={`inline-connect-${packageId}-${defaultAuthKey}`}
            >
              <Icon className="mr-1 size-3" />
              {text}
              <ChevronDown className="ml-1 size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {authKeys.map((k) => {
              const typeLabel = t(`settings:integration.auth.type.${auths[k]!.type}`);
              return (
                <DropdownMenuItem
                  key={k}
                  onSelect={() => triggerConnect(k)}
                  data-testid={`inline-connect-pick-${packageId}-${k}`}
                >
                  {t("settings:integration.auth.connectVia", { label: typeLabel })}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          size={size}
          onClick={() => triggerConnect(defaultAuthKey)}
          disabled={disabled}
          title={tooltip}
          data-testid={`inline-connect-${packageId}-${defaultAuthKey}`}
        >
          <Icon className="mr-1 size-3" />
          {text}
        </Button>
      )}
      {fieldsAuth && fieldsAuthKey && (
        <FieldsConnectModal
          open={true}
          onClose={() => setFieldsAuthKey(null)}
          packageId={packageId}
          authKey={fieldsAuthKey}
          auth={fieldsAuth}
          displayName={displayName}
          {...(connectionId ? { connectionId } : {})}
          {...(onConnected ? { onConnected: () => onConnected() } : {})}
        />
      )}
    </>
  );
}
