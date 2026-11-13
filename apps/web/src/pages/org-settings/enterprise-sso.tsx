// SPDX-License-Identifier: Apache-2.0

/**
 * Enterprise sign-in: the organization binds its Microsoft tenant, proves its email domains by
 * DNS, then may require Microsoft for those addresses. The route opens on `org-sso:read` under
 * `features.enterpriseSso` (`lib/route-access.ts`); every change is `org-sso:write` (owners).
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Globe, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { PendingButton } from "../../components/app-ui/pending-button";
import { OptionSelect } from "../../components/app-ui/option-select";
import { ConfirmModal } from "../../components/confirm-modal";
import { CopyBlock } from "../../components/copy-block";
import { DisabledReasonTooltip } from "../../components/disabled-reason-tooltip";
import { EmptyState, ErrorState } from "../../components/page-states";
import { SettingsSkeleton } from "../../components/loading-skeletons";
import { RoleLimitNotice } from "../../components/role-limit-notice";
import { SaveFeedback } from "../../components/settings/save-feedback";
import { SettingRow, SettingsGroup } from "../../components/settings/setting-row";
import { useAppConfig } from "../../hooks/use-app-config";
import { useAuth } from "../../hooks/use-auth";
import { useOrgSso, useOrgSsoMutations } from "../../hooks/use-org-sso";
import { usePermissions } from "../../hooks/use-permissions";
import { fieldWriteState } from "../../lib/field-write-state";
import { formatDateField } from "../../lib/format-date";
import { refusalMessage, toastError } from "../../lib/mutation-error";
import {
  enforcementBlocker,
  ORG_SSO_PATH,
  socialCallbackError,
  SSO_CONNECT_PARAM,
  ssoDomainBody,
  ssoJoinRoleBody,
  type EnforcementBlocker,
  type SsoDomain,
  type SsoJoinRole,
  type SsoSettings,
} from "../../lib/org-sso";
import { searchOf } from "../../lib/url-search";

const BLOCKER_KEYS: Record<EnforcementBlocker, string> = {
  no_tenant: "orgSso.blockerNoTenant",
  no_verified_domain: "orgSso.blockerNoVerifiedDomain",
  other_session: "orgSso.blockerOtherSession",
};

const JOIN_ROLE_KEYS: Record<SsoJoinRole, string> = {
  member: "orgSettings.roleMember",
  guest: "orgSettings.roleGuest",
};

type SsoMutations = ReturnType<typeof useOrgSsoMutations>;

type PendingConfirm =
  | { kind: "unlink" }
  | { kind: "enforce" }
  | { kind: "lift" }
  | { kind: "removeDomain"; domain: SsoDomain };

export function OrgSettingsEnterpriseSsoPage() {
  const { data, error } = useOrgSso();
  if (error) return <ErrorState error={error} />;
  if (!data) return <SettingsSkeleton />;
  return <EnterpriseSsoSettings settings={data} />;
}

function EnterpriseSsoSettings({ settings }: { settings: SsoSettings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const canWrite = can("org-sso:write");
  const { features } = useAppConfig();
  const microsoftAvailable = features.microsoftAuth;
  const { signInWithSocial } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const mutations = useOrgSsoMutations();
  const { linkTenant } = mutations;

  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  // A Microsoft sign-in started here and refused at its callback lands back with `?error=`.
  const [callbackRefusal] = useState(() => socialCallbackError(location.search));

  // The Microsoft sign-in leaves the SPA: it comes back here, with `?connect=1` when it was
  // started to bind the tenant, or with `?error=` when its callback refused it.
  const signInWithMicrosoft = (connect: boolean) => {
    setRedirecting(true);
    const back = connect ? `${ORG_SSO_PATH}?${SSO_CONNECT_PARAM}=1` : ORG_SSO_PATH;
    signInWithSocial("microsoft", back, ORG_SSO_PATH).catch((err: unknown) => {
      setRedirecting(false);
      toastError(err);
    });
  };

  // Back from that sign-in: drop the flags from the address (a reload binds nothing twice), then
  // bind the tenant of the session it opened, once.
  const returnHandled = useRef(false);
  useEffect(() => {
    if (returnHandled.current) return;
    const params = new URLSearchParams(location.search);
    const connect = params.has(SSO_CONNECT_PARAM);
    const refused = params.has("error");
    if (!connect && !refused) return;
    returnHandled.current = true;
    for (const name of [SSO_CONNECT_PARAM, "error", "error_description"]) params.delete(name);
    navigate(
      { search: searchOf(params), hash: location.hash },
      { replace: true, state: location.state },
    );
    if (connect && !refused && canWrite)
      linkTenant.mutate({}, { onError: (err) => toastError(err) });
  }, [location, navigate, canWrite, linkTenant]);

  // A session a Microsoft sign-in opened less than 15 minutes ago binds at once; any other asks
  // for that sign-in first.
  const connectTenant = () => {
    if (!settings.caller_tenant_id) {
      signInWithMicrosoft(true);
      return;
    }
    linkTenant.mutate(
      {},
      {
        onError: (err) => {
          if (err.code === "microsoft_session_required") {
            signInWithMicrosoft(true);
          } else {
            toastError(err);
          }
        },
      },
    );
  };

  return (
    <>
      {!canWrite && <RoleLimitNotice className="mb-6">{t("orgSso.readOnly")}</RoleLimitNotice>}

      {callbackRefusal && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            {refusalMessage({ code: callbackRefusal }) ?? t("orgSso.microsoftFailed")}
          </AlertDescription>
        </Alert>
      )}

      <TenantSection
        settings={settings}
        canWrite={canWrite}
        microsoftAvailable={microsoftAvailable}
        connecting={linkTenant.isPending || redirecting}
        onConnect={connectTenant}
        onUnlink={() => setPendingConfirm({ kind: "unlink" })}
      />

      <DomainsSection
        settings={settings}
        canWrite={canWrite}
        mutations={mutations}
        onRemove={(domain) => setPendingConfirm({ kind: "removeDomain", domain })}
      />

      <SettingsGroup title={t("orgSso.joinTitle")}>
        <SettingRow
          variant="field"
          label={t("orgSso.joinRoleLabel")}
          description={t("orgSso.joinRoleHint")}
          status={<SaveFeedback {...fieldWriteState(mutations.update, "join_role")} />}
        >
          {(labelId) => (
            <OptionSelect
              aria-labelledby={labelId}
              className="w-full sm:w-[240px]"
              value={settings.join_role}
              disabled={!canWrite || mutations.update.isPending}
              options={(["member", "guest"] as const).map((role) => ({
                value: role,
                label: t(JOIN_ROLE_KEYS[role]),
              }))}
              onValueChange={(role) =>
                mutations.update.mutate({ body: ssoJoinRoleBody(role as SsoJoinRole) })
              }
            />
          )}
        </SettingRow>
      </SettingsGroup>

      <EnforcementSection
        settings={settings}
        canWrite={canWrite}
        microsoftAvailable={microsoftAvailable}
        redirecting={redirecting}
        onSignIn={() => signInWithMicrosoft(false)}
        onEnforce={() => setPendingConfirm({ kind: "enforce" })}
        onLift={() => setPendingConfirm({ kind: "lift" })}
      />

      <SsoConfirmModal
        pending={pendingConfirm}
        settings={settings}
        mutations={mutations}
        onClose={() => setPendingConfirm(null)}
      />
    </>
  );
}

function TenantSection({
  settings,
  canWrite,
  microsoftAvailable,
  connecting,
  onConnect,
  onUnlink,
}: {
  settings: SsoSettings;
  canWrite: boolean;
  microsoftAvailable: boolean;
  connecting: boolean;
  onConnect: () => void;
  onUnlink: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const connected = settings.tenant_id !== null;
  let control: ReactNode = null;
  if (canWrite && connected) {
    control = (
      <DisabledReasonTooltip reason={settings.enforced ? t("orgSso.unlinkEnforced") : null}>
        <Button variant="outline" disabled={settings.enforced} onClick={onUnlink}>
          {t("orgSso.unlink")}
        </Button>
      </DisabledReasonTooltip>
    );
  } else if (canWrite && microsoftAvailable) {
    control = (
      <PendingButton pending={connecting} onClick={onConnect}>
        {t("orgSso.connect")}
      </PendingButton>
    );
  }
  return (
    <SettingsGroup title={t("orgSso.tenantTitle")}>
      <SettingRow
        variant="action"
        label={
          <span className="flex flex-wrap items-center gap-2">
            {t("orgSso.tenantLabel")}
            <Badge variant={connected ? "success" : "pending"}>
              {connected ? t("orgSso.tenantConnected") : t("orgSso.tenantNotConnected")}
            </Badge>
          </span>
        }
        description={
          <>
            {connected && (
              <span className="mb-1 block">
                {t("orgSso.tenantId")} <span className="font-mono">{settings.tenant_id}</span>
              </span>
            )}
            {!connected && !microsoftAvailable
              ? t("orgSso.microsoftUnavailable")
              : t("orgSso.tenantHint")}
          </>
        }
      >
        {control}
      </SettingRow>
    </SettingsGroup>
  );
}

function DomainsSection({
  settings,
  canWrite,
  mutations: { addDomain, verifyDomain },
  onRemove,
}: {
  settings: SsoSettings;
  canWrite: boolean;
  mutations: SsoMutations;
  onRemove: (domain: SsoDomain) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    addDomain.mutate({ body: ssoDomainBody(draft) }, { onSuccess: () => setDraft("") });
  };

  return (
    <SettingsGroup title={t("orgSso.domainsTitle")}>
      <p className="text-muted-foreground mb-4 text-xs leading-relaxed">
        {t("orgSso.domainsHint")}
      </p>
      {canWrite && (
        <form onSubmit={submit} className="mb-4 flex flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 sm:max-w-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("orgSso.domainPlaceholder")}
            aria-label={t("orgSso.domainLabel")}
            autoComplete="off"
            spellCheck={false}
            disabled={addDomain.isPending}
          />
          <PendingButton type="submit" pending={addDomain.isPending} disabled={!draft.trim()}>
            {t("orgSso.addDomain")}
          </PendingButton>
        </form>
      )}
      {settings.domains.length === 0 ? (
        <EmptyState compact icon={Globe} message={t("orgSso.domainsEmpty")} />
      ) : (
        <ul className="bg-card divide-border divide-y rounded-lg border">
          {settings.domains.map((domain) => {
            const removeLocked = domain.verified && settings.enforced;
            const verifying =
              verifyDomain.isPending && verifyDomain.variables?.params.path.domainId === domain.id;
            return (
              <li key={domain.id} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-mono text-sm break-all">{domain.domain}</span>
                    <Badge variant={domain.verified ? "success" : "pending"}>
                      {domain.verified ? t("orgSso.domainVerified") : t("orgSso.domainPending")}
                    </Badge>
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-2">
                      {!domain.verified && (
                        <PendingButton
                          size="sm"
                          variant="outline"
                          pending={verifying}
                          onClick={() =>
                            verifyDomain.mutate({ params: { path: { domainId: domain.id } } })
                          }
                        >
                          {t("orgSso.verify")}
                        </PendingButton>
                      )}
                      <DisabledReasonTooltip
                        reason={removeLocked ? t("orgSso.removeEnforced") : null}
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removeLocked}
                          aria-label={t("orgSso.removeDomainAria", { domain: domain.domain })}
                          onClick={() => onRemove(domain)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </DisabledReasonTooltip>
                    </div>
                  )}
                </div>
                {domain.verified ? (
                  <p className="text-muted-foreground text-xs">
                    {t("orgSso.verifiedOn", {
                      date: formatDateField(domain.verified_at, "date"),
                    })}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {t("orgSso.txtHint")}
                    </p>
                    <div className="grid gap-2 md:grid-cols-[auto_1fr] md:items-center">
                      <span className="text-muted-foreground text-xs">{t("orgSso.txtName")}</span>
                      <CopyBlock dense value={domain.txt_record_name} />
                      <span className="text-muted-foreground text-xs">{t("orgSso.txtValue")}</span>
                      <CopyBlock dense value={domain.txt_record_value} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}

function EnforcementSection({
  settings,
  canWrite,
  microsoftAvailable,
  redirecting,
  onSignIn,
  onEnforce,
  onLift,
}: {
  settings: SsoSettings;
  canWrite: boolean;
  microsoftAvailable: boolean;
  redirecting: boolean;
  onSignIn: () => void;
  onEnforce: () => void;
  onLift: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const blocker = settings.enforced ? null : enforcementBlocker(settings);
  const reason = blocker ? t(BLOCKER_KEYS[blocker]) : null;
  let control: ReactNode = null;
  if (canWrite && settings.enforced) {
    control = (
      <Button variant="outline" onClick={onLift}>
        {t("orgSso.lift")}
      </Button>
    );
  } else if (canWrite) {
    control = (
      <DisabledReasonTooltip reason={reason}>
        <Button disabled={blocker !== null} onClick={onEnforce}>
          {t("orgSso.enforce")}
        </Button>
      </DisabledReasonTooltip>
    );
  }
  return (
    <SettingsGroup title={t("orgSso.enforcementTitle")}>
      <SettingRow
        variant="action"
        label={
          <span className="flex flex-wrap items-center gap-2">
            {t("orgSso.enforcementLabel")}
            <Badge variant={settings.enforced ? "success" : "pending"}>
              {settings.enforced ? t("orgSso.enforcedBadge") : t("orgSso.notEnforcedBadge")}
            </Badge>
          </span>
        }
        description={
          settings.enforced
            ? t("orgSso.enforcedSince", { date: formatDateField(settings.enforced_at, "date") })
            : t("orgSso.enforcementHint")
        }
      >
        {control}
      </SettingRow>
      {reason && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground text-xs">{reason}</p>
          {blocker === "other_session" && canWrite && microsoftAvailable && (
            <PendingButton size="sm" variant="outline" pending={redirecting} onClick={onSignIn}>
              {t("orgSso.signInMicrosoft")}
            </PendingButton>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

function SsoConfirmModal({
  pending,
  settings,
  mutations,
  onClose,
}: {
  pending: PendingConfirm | null;
  settings: SsoSettings;
  mutations: SsoMutations;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const done = { onSuccess: onClose };
  const verified = settings.domains.filter((domain) => domain.verified).map((d) => d.domain);

  let props: {
    title: string;
    description: string;
    confirmLabel: string;
    variant: "default" | "destructive";
    isPending: boolean;
    onConfirm: () => void;
    children?: ReactNode;
  } = {
    title: "",
    description: "",
    confirmLabel: "",
    variant: "default",
    isPending: false,
    onConfirm: () => {},
  };
  switch (pending?.kind) {
    case "unlink":
      props = {
        title: t("orgSso.unlinkTitle"),
        description: t("orgSso.unlinkDesc"),
        confirmLabel: t("orgSso.unlink"),
        variant: "destructive",
        isPending: mutations.unlinkTenant.isPending,
        onConfirm: () => mutations.unlinkTenant.mutate({}, done),
      };
      break;
    case "removeDomain": {
      const { domain } = pending;
      props = {
        title: t("orgSso.removeDomainTitle"),
        description: t("orgSso.removeDomainDesc", { domain: domain.domain }),
        confirmLabel: t("orgSso.removeDomain"),
        variant: "destructive",
        isPending: mutations.removeDomain.isPending,
        onConfirm: () =>
          mutations.removeDomain.mutate({ params: { path: { domainId: domain.id } } }, done),
      };
      break;
    }
    case "enforce":
      props = {
        title: t("orgSso.enforceTitle"),
        description: t("orgSso.enforceDesc", { domains: verified.join(", ") }),
        confirmLabel: t("orgSso.enforce"),
        variant: "default",
        isPending: mutations.enforce.isPending,
        onConfirm: () => mutations.enforce.mutate({}, done),
        children: (
          <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>{t("orgSso.enforceSessions")}</li>
            <li>{t("orgSso.enforceRefused")}</li>
            <li>{t("orgSso.enforceEmergency")}</li>
          </ul>
        ),
      };
      break;
    case "lift":
      props = {
        title: t("orgSso.liftTitle"),
        description: t("orgSso.liftDesc"),
        confirmLabel: t("orgSso.lift"),
        variant: "default",
        isPending: mutations.lift.isPending,
        onConfirm: () => mutations.lift.mutate({}, done),
      };
      break;
  }

  const { children, ...rest } = props;
  return (
    <ConfirmModal open={pending !== null} onClose={onClose} {...rest}>
      {children}
    </ConfirmModal>
  );
}
