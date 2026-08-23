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
import { FlaskConical, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { OrgModelInfo } from "../../hooks/use-models";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import type { TestResult } from "../../hooks/use-connection-test";
import type { DataColumn } from "../../components/data-table";
import { getModelIcon, getProviderIcon } from "../../components/icons";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/provider-registry-helpers";
import { formatDateField } from "../../lib/markdown";
import { TestResultSpan } from "../../components/test-result-span";
import { TableRowActions } from "../../components/table-row-actions";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { SourceBadge } from "../../components/source-badge";
import { ModelUnavailableBadge } from "../../components/model-availability-badge";
import { DefaultCell } from "../../components/default-cell";
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
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  settingDefaultId: string | null;
  onTest: (id: string) => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
}): DataColumn<OrgModelInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

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
      width: "minmax(50px,0.8fr)",
      tier: 2,
      cell: (m) => (
        <span className="text-muted-foreground block truncate text-xs">
          {m.providerName ?? m.providerId ?? m.apiShape}
        </span>
      ),
    },
    {
      id: "identifier",
      header: t("models.col.identifier"),
      width: "minmax(70px,1fr)",
      tier: 2,
      cell: (m) => (
        <span className="text-muted-foreground block truncate font-mono text-[0.65rem]">
          {m.aliased ? t("models.aliasHidden") : m.modelId}
        </span>
      ),
    },
    {
      id: "status",
      header: t("models.col.status"),
      width: "minmax(50px,1fr)",
      tier: 2,
      cell: (m) => (
        <div className="relative z-10 flex min-w-0 flex-wrap items-center gap-1.5">
          {testResults[m.id] ? (
            <TestResultSpan
              result={testResults[m.id]!}
              successKey="models.testSuccess"
              failedKey="models.testFailed"
            />
          ) : (
            <>
              <SourceBadge source={m.source} />
              {m.aliased && <Badge variant="secondary">{t("models.alias")}</Badge>}
              {m.source !== "built-in" && !m.enabled && (
                <Badge variant="secondary" className="opacity-60">
                  {t("models.disabled")}
                </Badge>
              )}
              {m.needs_reconnection && <ModelUnavailableBadge />}
              {isModelUnpriced(m) && (
                <Badge variant="warning" title={t("models.unpricedHint")}>
                  {t("models.unpriced")}
                </Badge>
              )}
            </>
          )}
        </div>
      ),
    },
    {
      id: "default",
      header: t("models.col.default"),
      width: "120px",
      tier: 2,
      cell: (m) => (
        /* Shown but disabled, not hidden: `PUT /api/models/default` answers 409
           `model_needs_reconnection` for such a row, and a control that
           silently vanishes is what made this state impossible to reason
           about. The why is on the row's `ModelUnavailableBadge`, whose
           `title` sits on a hoverable element. */
        <DefaultCell
          isDefault={m.is_default}
          defaultLabel={t("models.default")}
          setLabel={t("models.setDefault")}
          onSetDefault={() => onSetDefault(m)}
          disabled={m.needs_reconnection || settingDefaultId !== null}
          isPending={settingDefaultId === m.id}
          testId={`set-default-model-${m.id}`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (m) => {
        const isTesting = testingIds.has(m.id);
        const isCustom = m.source !== "built-in";
        const canEdit = isCustom && !m.aliased;
        return (
          <div className="relative z-10 flex min-w-0 items-center justify-end gap-1">
            <TableRowActions
              primary={canEdit ? { label: t("models.edit"), onSelect: () => onEdit(m) } : undefined}
              menuLabel={t("models.moreActions", { name: m.label })}
              isPending={isTesting}
              pendingLabel={t("common:loading")}
            >
              <DropdownMenuItem onSelect={() => onTest(m.id)} disabled={isTesting}>
                <FlaskConical />
                {t("models.test")}
              </DropdownMenuItem>
              {isCustom && (
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

/**
 * The credential column set. Five columns in the settings modal's 775px, so
 * the two that are pure information — when it was created, and a status that
 * repeats what the badges already say — are the ones that wait.
 */
export function useCredentialColumns({
  registry,
  testingIds,
  testResults,
  onTest,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  onTest: (id: string) => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => void;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
}): DataColumn<ModelProviderCredentialInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  const isOauth = (pk: ModelProviderCredentialInfo) => pk.authMode === "oauth2";

  return [
    {
      id: "provider",
      header: t("credentials.col.provider"),
      width: "minmax(160px,1.6fr)",
      cell: (pk) => {
        const ProviderIcon = getProviderIcon(
          findProviderByApiShapeAndBaseUrl(pk.apiShape, pk.baseUrl, registry ?? []),
        );
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
            <div className="relative z-10 min-w-0">
              <InlineEditableLabel
                value={pk.label}
                editable={pk.source === "custom" && !isOauth(pk)}
                onSave={(newLabel) => onRename(pk, newLabel)}
              />
              {isOauth(pk) && pk.oauth_email && (
                <div className="text-muted-foreground truncate text-[0.65rem]">
                  {t("credentials.oauth.connectedAs", { email: pk.oauth_email })}
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "auth",
      header: t("credentials.col.auth"),
      width: "112px",
      tier: 2,
      cell: (pk) =>
        isOauth(pk) ? (
          <Badge variant="secondary">{t("credentials.oauth.badgeOauth")}</Badge>
        ) : (
          <SourceBadge source={pk.source} />
        ),
    },
    {
      id: "status",
      header: t("credentials.col.status"),
      width: "minmax(120px,1fr)",
      tier: 3,
      cell: (pk) =>
        pk.needs_reconnection ? (
          // The flag also fires on a stored secret that no longer decrypts,
          // which reaches api-key credentials — where the fix is to re-enter
          // the key (Edit), not to reconnect an account.
          <Badge variant="destructive">
            {isOauth(pk)
              ? t("credentials.oauth.needsReconnection")
              : t("models.credentialUnavailable")}
          </Badge>
        ) : pk.source === "built-in" ? (
          <span className="text-muted-foreground text-xs">{t("source.builtIn")}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "created",
      header: t("credentials.col.created"),
      width: "132px",
      align: "end",
      tier: 3,
      cell: (pk) => (
        <span className="text-muted-foreground text-xs">
          {pk.createdAt ? formatDateField(pk.createdAt) : "—"}
        </span>
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
        const canReconnect = oauth && pk.needs_reconnection && Boolean(pk.providerId);
        const isTesting = testingIds.has(pk.id);
        if (!isCustomKey && !oauth) return null;
        return (
          <div className="relative z-10 flex min-w-0 items-center justify-end gap-1">
            {testResults[pk.id] && (
              <TestResultSpan
                result={testResults[pk.id]!}
                successKey="credentials.testSuccess"
                failedKey="credentials.testFailed"
              />
            )}
            <TableRowActions
              primary={
                isCustomKey
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
              {isCustomKey && (
                <>
                  <DropdownMenuItem onSelect={() => onTest(pk.id)} disabled={isTesting}>
                    <FlaskConical />
                    {t("credentials.test")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onSelect={() => onDelete(pk)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 />
                {oauth ? t("credentials.oauth.disconnect") : t("credentials.delete")}
              </DropdownMenuItem>
            </TableRowActions>
          </div>
        );
      },
    },
  ];
}
