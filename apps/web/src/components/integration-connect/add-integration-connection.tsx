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
import { isConnectionOwnedBy } from "./connection-label";
import { useHostedConnectPopup } from "./use-integration-oauth-popup";

/** Single action for an integration; only genuinely multi-auth packages need a picker. */
export function AddIntegrationConnection({
  packageId,
  detail,
  userId,
  onConfigure,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  userId?: string;
  onConfigure: (authKey?: string) => void;
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
        {detail.auths.map((auth) => (
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
