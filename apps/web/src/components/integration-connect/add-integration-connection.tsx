// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ChevronDown, Plus, Settings2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { IntegrationDetailWire, IntegrationAuthStatus } from "../../hooks/use-integrations";
import { authMethodLabel } from "../../lib/integration-presentation";
import { connectableAuthKeys } from "./connectable-auth-keys";
import { isConnectionOwnedBy } from "./connection-ownership";
import { useHostedConnectPopup } from "./use-integration-oauth-popup";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";

/** Single action for an integration; only genuinely multi-auth packages need a picker. */
export function AddIntegrationConnection({
  packageId,
  detail,
  userId,
  onConfigure,
  canConfigure,
  canConnect,
  blockedReason,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  userId?: string;
  onConfigure: (authKey?: string) => void;
  /** Setting up an auth method (`integrations:configure`). */
  canConfigure: boolean;
  /** Adding one's own connection (`integrations:connect`). */
  canConnect: boolean;
  /** Why adding one's own is refused here (an admin blocked personal connections). */
  blockedReason?: string;
}) {
  const { t } = useTranslation("settings");
  const { openPopup, isPending } = useHostedConnectPopup();
  const allowed = connectableAuthKeys(detail.manifest, detail.auths);
  const connect = (auth: IntegrationAuthStatus) => {
    if (!allowed.has(auth.auth_key)) return;
    void openPopup({
      packageId,
      authKey: auth.auth_key,
      forceAccountSelect: auth.connections.some((connection) =>
        isConnectionOwnedBy(connection, userId),
      ),
    });
  };
  if (!detail.auths.length) return null;
  if (!allowed.size && !canConfigure) return null;
  if (!allowed.size)
    return (
      <Button
        variant="outline"
        size="sm"
        className="@max-sm/bar:size-8 @max-sm/bar:p-0"
        aria-label={t("integration.presentation.configureAuth")}
        title={t("integration.presentation.configureAuth")}
        onClick={() => onConfigure(detail.auths[0]?.auth_key)}
      >
        <Settings2 className="size-4" />
        <span className="hidden @sm/bar:inline">{t("integration.presentation.configureAuth")}</span>
      </Button>
    );
  const label = t("integration.presentation.addConnection");
  // The button the server would refuse stays, dead, with the reason on it.
  if (blockedReason && canConnect)
    return (
      <DisabledReasonTooltip reason={blockedReason}>
        <Button
          variant="outline"
          size="sm"
          className="@max-sm/bar:size-8 @max-sm/bar:p-0"
          aria-label={label}
          disabled
          data-testid="connections-blocked-by-admin"
        >
          <Plus className="size-4" />
          <span className="hidden @sm/bar:inline">{label}</span>
        </Button>
      </DisabledReasonTooltip>
    );
  // Each method offers what the caller may do with it: connect when it is
  // set up, set it up when it is not.
  const offered = detail.auths.filter((auth) =>
    allowed.has(auth.auth_key) ? canConnect : canConfigure,
  );
  if (!offered.length) return null;
  if (detail.auths.length === 1)
    return (
      <Button
        variant="outline"
        size="sm"
        className="@max-sm/bar:size-8 @max-sm/bar:p-0"
        aria-label={label}
        title={label}
        onClick={() => connect(detail.auths[0]!)}
        disabled={isPending}
      >
        <Plus className="size-4" />
        <span className="hidden @sm/bar:inline">{label}</span>
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="@max-sm/bar:size-8 @max-sm/bar:p-0"
          aria-label={label}
          title={label}
          disabled={isPending}
        >
          <Plus className="size-4" />
          <span className="hidden @sm/bar:inline">{label}</span>
          <ChevronDown className="hidden size-4 @sm/bar:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {offered.map((auth) => (
          <DropdownMenuItem
            key={auth.auth_key}
            onSelect={() =>
              allowed.has(auth.auth_key) ? connect(auth) : onConfigure(auth.auth_key)
            }
          >
            <div>
              <p>{authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`))}</p>
              {!allowed.has(auth.auth_key) && (
                <p className="text-muted-foreground text-xs">
                  {t("integration.presentation.setupFirst")}
                </p>
              )}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
