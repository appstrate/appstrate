// SPDX-License-Identifier: Apache-2.0

/**
 * The two settings column sets, out of the page they are drawn on.
 *
 * A column set is data, not a screen, and the other three already live beside
 * their table rather than inside a page. Here there is a second reason: the
 * page imports the credential modal, which reaches an `@/…` alias the test
 * runner does not resolve, so a set left in the page could not be held to
 * `column-tiers.test.tsx` at all — and a set that is not in that test inherits
 * the tier rule without being checked against it.
 */

import { useTranslation } from "react-i18next";
import { CheckCircle2, FlaskConical, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { OrgModelInfo } from "../../hooks/use-models";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import type { TestResult } from "../../hooks/use-connection-test";
import type { DataColumn } from "../../components/data-table";
import { getModelIcon, getProviderIcon } from "../../components/icons";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/provider-registry-helpers";
import { TestResultSpan } from "../../components/test-result-span";
import { TableRowActions } from "../../components/table-row-actions";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { ModelUnavailableBadge } from "../../components/model-availability-badge";
import { isModelUnpriced } from "./model-pricing";

/** The model's comparable facts each get their own desktop column. */
export function useModelColumns({
  registry,
  testingIds,
  testResults,
  settingDefaultId,
  onTest,
  onEdit,
  onDelete,
  onSetDefault,
  canWrite,
  canDelete,
  credentialLabels,
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  settingDefaultId: string | null;
  onTest: (id: string) => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  /** Resolved once by the page: a row action absent here 403s if clicked. */
  canWrite: boolean;
  canDelete: boolean;
  /** The organization credentials' labels by id, for those the caller may read. */
  credentialLabels: ReadonlyMap<string, string>;
}): DataColumn<OrgModelInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  // A managed (aliased) row hides its binding, so it names no credential.
  // An unbound one is paid by whoever uses it: each member brings their own.
  const credentialText = (m: OrgModelInfo) =>
    m.aliased
      ? "—"
      : m.credentialId === null
        ? t("models.credentialEachMember")
        : (credentialLabels.get(m.credentialId) ?? "—");

  return [
    {
      id: "model",
      header: t("models.col.model"),
      width: "minmax(80px,1.4fr)",
      cell: (m) => {
        const ProviderIcon = getModelIcon(m, registry ?? []);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
            <div className="min-w-0">
              <span className="block truncate text-sm font-medium">{m.label}</span>
              {testResults[m.id] && (
                <div className="@xl/table:hidden">
                  <TestResultSpan
                    result={testResults[m.id]!}
                    successKey="models.testSuccess"
                    failedKey="models.testFailed"
                  />
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "provider",
      header: t("models.col.provider"),
      width: "minmax(48px,0.9fr)",
      tier: 2,
      cell: (m) => (
        <span className="text-muted-foreground block truncate text-xs">
          {m.provider_name ?? m.providerId ?? m.apiShape}
        </span>
      ),
    },
    {
      id: "type",
      header: t("models.col.type"),
      width: "88px",
      tier: 2,
      cell: (m) => (
        <span className="text-muted-foreground block truncate text-xs">
          {m.aliased
            ? t("models.alias")
            : m.source === "built-in"
              ? t("source.builtIn")
              : t("source.custom")}
        </span>
      ),
    },
    {
      id: "credential",
      header: t("models.col.credential"),
      width: "minmax(84px,1fr)",
      tier: 3,
      cell: (m) => (
        <span className="text-muted-foreground block truncate text-xs" title={credentialText(m)}>
          {credentialText(m)}
        </span>
      ),
    },
    {
      id: "status",
      header: t("models.col.status"),
      width: "minmax(96px,1fr)",
      tier: 2,
      cell: (m) => (
        <div className="relative z-10 min-w-0">
          {testResults[m.id] ? (
            <TestResultSpan
              result={testResults[m.id]!}
              successKey="models.testSuccess"
              failedKey="models.testFailed"
            />
          ) : m.needs_reconnection ? (
            <ModelUnavailableBadge />
          ) : !m.enabled ? (
            <Badge variant="secondary" className="opacity-60">
              {t("models.disabled")}
            </Badge>
          ) : isModelUnpriced(m) ? (
            <Badge variant="warning" title={t("models.unpricedHint")}>
              {t("models.unpriced")}
            </Badge>
          ) : (
            <Badge variant="success">{t("models.active")}</Badge>
          )}
        </div>
      ),
    },
    {
      id: "default",
      header: t("models.col.default"),
      width: "96px",
      tier: 3,
      cell: (m) =>
        m.is_default ? (
          <Badge variant="success">{t("models.default")}</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (m) => {
        const isTesting = testingIds.has(m.id);
        const isSettingDefault = settingDefaultId === m.id;
        const isCustom = m.source !== "built-in";
        const canEdit = isCustom && !m.aliased && canWrite;
        return (
          <div className="relative z-10 flex min-w-0 items-center justify-end gap-1">
            <TableRowActions
              primary={canEdit ? { label: t("models.edit"), onSelect: () => onEdit(m) } : undefined}
              menuLabel={t("models.moreActions", { name: m.label })}
              isPending={isTesting || isSettingDefault}
              pendingLabel={t("common:loading")}
            >
              <DropdownMenuItem onSelect={() => onTest(m.id)} disabled={isTesting}>
                <FlaskConical />
                {t("models.test")}
              </DropdownMenuItem>
              {!m.is_default && (
                <DropdownMenuItem
                  onSelect={() => onSetDefault(m)}
                  // `PUT /api/models/default` answers 409 for these rows; a
                  // switched-off system model stays eligible, the server
                  // refuses only a disabled custom one.
                  disabled={
                    m.needs_reconnection ||
                    (m.source !== "built-in" && !m.enabled) ||
                    settingDefaultId !== null
                  }
                  data-testid={`set-default-model-${m.id}`}
                >
                  <CheckCircle2 />
                  {t("models.setDefault")}
                </DropdownMenuItem>
              )}
              {isCustom && canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onDelete(m)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 />
                    {t("models.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </TableRowActions>
          </div>
        );
      },
    },
  ];
}

/** Provider-credential facts stay aligned instead of becoming a badge stack. */
export function useCredentialColumns({
  registry,
  testingIds,
  testResults,
  onTest,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
  canWrite,
  canDelete,
  userId,
  showOwner = false,
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  onTest: (id: string) => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => void;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
  /** Resolved once by the page: a row action absent here 403s if clicked. */
  canWrite: boolean;
  canDelete: boolean;
  /** The caller: a personal credential is changed by its holder alone. */
  userId: string | undefined;
  /** Whether the owner column shows; a personal-only list has one owner, the caller. */
  showOwner?: boolean;
}): DataColumn<ModelProviderCredentialInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  const isOauth = (pk: ModelProviderCredentialInfo) => pk.authMode === "oauth2";
  const isOwn = (pk: ModelProviderCredentialInfo) =>
    pk.owner_type === "user" && pk.owner_id === userId;
  // A personal credential is changed by its holder alone (404 to anyone else),
  // so an administrator's write right covers the organization's rows only.
  const canEdit = (pk: ModelProviderCredentialInfo) =>
    pk.owner_type === "org" ? canWrite : isOwn(pk);

  return [
    {
      id: "provider",
      header: t("credentials.col.provider"),
      width: "minmax(96px,1.4fr)",
      cell: (pk) => {
        const ProviderIcon = getProviderIcon(
          findProviderByApiShapeAndBaseUrl(pk.apiShape, pk.base_url, registry ?? []),
        );
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
            <div className="relative z-10 min-w-0">
              <InlineEditableLabel
                value={pk.label}
                // A subscription is renamed here too: its connection changes only
                // through the reconnect, never its label.
                editable={pk.source === "custom" && canEdit(pk)}
                onSave={(newLabel) => onRename(pk, newLabel)}
              />
              {testResults[pk.id] && (
                <div className="@xl/table:hidden">
                  <TestResultSpan
                    result={testResults[pk.id]!}
                    successKey="credentials.testSuccess"
                    failedKey="credentials.testFailed"
                  />
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    ...(showOwner
      ? [
          {
            id: "owner",
            header: t("credentials.col.owner"),
            width: "minmax(72px,0.8fr)" as const,
            tier: 3 as const,
            cell: (pk: ModelProviderCredentialInfo) => (
              <span className="text-muted-foreground block truncate text-xs">
                {pk.owner_type === "org" ? t("source.org") : (pk.owner_name ?? "—")}
              </span>
            ),
          },
        ]
      : []),
    {
      id: "account",
      header: t("credentials.col.account"),
      width: "minmax(84px,1.1fr)",
      tier: 2,
      cell: (pk) => (
        <span className="text-muted-foreground block truncate text-xs">
          {pk.oauth_email ?? "—"}
        </span>
      ),
    },
    {
      id: "type",
      header: t("credentials.col.type"),
      width: "72px",
      tier: 2,
      cell: (pk) => (
        <span className="text-muted-foreground block truncate text-xs">
          {pk.source === "built-in"
            ? t("source.builtIn")
            : isOauth(pk)
              ? t("credentials.oauth.badgeOauth")
              : t("credentials.apiKey")}
        </span>
      ),
    },
    {
      id: "status",
      header: t("credentials.col.status"),
      width: "minmax(96px,1fr)",
      tier: 2,
      cell: (pk) =>
        testResults[pk.id] ? (
          <TestResultSpan
            result={testResults[pk.id]!}
            successKey="credentials.testSuccess"
            failedKey="credentials.testFailed"
          />
        ) : pk.needs_reconnection ? (
          // The flag also fires on a stored secret that no longer decrypts,
          // which reaches api-key credentials — where the fix is to re-enter
          // the key (Edit), not to reconnect an account.
          <Badge variant="destructive">
            {isOauth(pk)
              ? t("credentials.oauth.needsReconnection")
              : t("models.credentialUnavailable")}
          </Badge>
        ) : (
          <Badge variant="success">{t("credentials.available")}</Badge>
        ),
    },
    {
      id: "actions",
      header: "",
      // Same measured action footprint as the model rows above.
      width: "104px",
      align: "end",
      cell: (pk) => {
        const oauth = isOauth(pk);
        const isCustomKey = !oauth && pk.source === "custom";
        // Reconnecting is the holder's own act: the helper pairs an account to them.
        const canReconnect =
          oauth && pk.needs_reconnection && Boolean(pk.providerId) && isOwn(pk) && canWrite;
        const canEditKey = isCustomKey && canEdit(pk);
        const isTesting = testingIds.has(pk.id);
        if (!isCustomKey && !oauth) return null;
        return (
          <div className="relative z-10 flex min-w-0 items-center justify-end gap-1">
            <TableRowActions
              primary={
                canEditKey
                  ? { label: t("credentials.edit"), onSelect: () => onEdit(pk) }
                  : canReconnect
                    ? {
                        label: t("credentials.oauth.reconnect"),
                        onSelect: () => onConnectOAuth(pk),
                        icon: RotateCcw,
                      }
                    : undefined
              }
              menuLabel={t("credentials.moreActions", { name: pk.label })}
              isPending={isTesting}
              pendingLabel={t("common:loading")}
            >
              {(canEditKey || canDelete) && (
                <>
                  {canEditKey && (
                    <DropdownMenuItem onSelect={() => onTest(pk.id)} disabled={isTesting}>
                      <FlaskConical />
                      {t("credentials.test")}
                    </DropdownMenuItem>
                  )}
                  {canEditKey && canDelete && <DropdownMenuSeparator />}
                  {canDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(pk)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 />
                      {oauth ? t("credentials.oauth.disconnect") : t("credentials.delete")}
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </TableRowActions>
          </div>
        );
      },
    },
  ];
}
