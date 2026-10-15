// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps, ReactNode } from "react";
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
import { useHostedConnectPopup } from "./use-hosted-connect-popup";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { useModalTarget } from "../../hooks/use-modal-param";
import { connectPopupInput, scopeChoiceFor } from "../integration-detail/connect-scope-choice";
import {
  CONNECT_SCOPES_PARAM,
  ConnectScopesModal,
} from "../integration-detail/connect-scopes-dialog";

type AddProps = {
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
};

/**
 * Single action for an integration; only genuinely multi-auth packages need a picker. An oauth2
 * method with a `scope_catalog` asks which permissions to request first, in a modal
 * (`?connectScopes=<method>`); any other connects at once.
 */
export function AddIntegrationConnection(props: AddProps) {
  const { packageId, detail, userId } = props;
  const modal = useModalTarget(CONNECT_SCOPES_PARAM, detail.auths, (auth) => auth.auth_key);
  const { openPopup, isPending } = useHostedConnectPopup();
  const forceAccountSelect = (auth: IntegrationAuthStatus) =>
    auth.connections.some((connection) => isConnectionOwnedBy(connection, userId));
  const connect = (auth: IntegrationAuthStatus) => {
    if (!connectableAuthKeys(detail.manifest, detail.auths).has(auth.auth_key)) return;
    if (scopeChoiceFor(detail.manifest.auths?.[auth.auth_key])) modal.open(auth.auth_key);
    else
      void openPopup(
        connectPopupInput(
          { packageId, authKey: auth.auth_key, choice: null },
          [],
          forceAccountSelect(auth),
        ),
      );
  };
  const asked = modal.target;
  const choice = asked && scopeChoiceFor(detail.manifest.auths?.[asked.auth_key]);
  return (
    <>
      <AddButton {...props} connect={connect} isPending={isPending} />
      {asked && choice && (
        <ConnectScopesModal
          packageId={packageId}
          authKey={asked.auth_key}
          manifest={detail.manifest}
          choice={choice}
          forceAccountSelect={forceAccountSelect(asked)}
        />
      )}
    </>
  );
}

/** The add action's button in every state: icon alone once its `bar` container is narrow. */
function AddConnectionButton({
  icon,
  label,
  chevron = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  icon: ReactNode;
  label: string;
  chevron?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="@max-sm/bar:size-8 @max-sm/bar:p-0"
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
      <span className="hidden @sm/bar:inline">{label}</span>
      {chevron && <ChevronDown className="hidden @sm/bar:inline" />}
    </Button>
  );
}

function AddButton({
  detail,
  onConfigure,
  canConfigure,
  canConnect,
  blockedReason,
  connect,
  isPending,
}: AddProps & { connect: (auth: IntegrationAuthStatus) => void; isPending: boolean }) {
  const { t } = useTranslation("settings");
  const allowed = connectableAuthKeys(detail.manifest, detail.auths);
  const label = t("integration.presentation.addConnection");
  // The button the server would refuse stays, dead, with the reason on it.
  const refused = (reason: string, testId: string) => (
    <DisabledReasonTooltip reason={reason}>
      <AddConnectionButton icon={<Plus />} label={label} disabled data-testid={testId} />
    </DisabledReasonTooltip>
  );
  if (!detail.auths.length) return null;
  // Only oauth2 methods without a usable client: registering one is an administrator's act.
  if (!allowed.size && !canConfigure)
    return refused(t("integration.auth.noClientHint"), "no-oauth-client");
  if (!allowed.size)
    return (
      <AddConnectionButton
        icon={<Settings2 />}
        label={t("integration.presentation.configureAuth")}
        onClick={() => onConfigure(detail.auths[0]?.auth_key)}
      />
    );
  if (blockedReason && canConnect) return refused(blockedReason, "connections-blocked-by-admin");
  // Each method offers what the caller may do with it: connect when it is
  // set up, set it up when it is not.
  const offered = detail.auths.filter((auth) =>
    allowed.has(auth.auth_key) ? canConnect : canConfigure,
  );
  if (!offered.length) return null;
  if (detail.auths.length === 1)
    return (
      <AddConnectionButton
        icon={<Plus />}
        label={label}
        onClick={() => connect(detail.auths[0]!)}
        disabled={isPending}
      />
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <AddConnectionButton icon={<Plus />} label={label} chevron disabled={isPending} />
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
