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
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import type { OrgModelInfo } from "../../hooks/use-models";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import type { TestResult } from "../../hooks/use-connection-test";
import type { DataColumn } from "../../components/data-table";
import { getModelIcon, getProviderIcon } from "../../components/icons";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/provider-registry-helpers";
import { formatDateField } from "../../lib/markdown";
import { Spinner } from "../../components/spinner";
import { TestResultSpan } from "../../components/test-result-span";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { SourceBadge } from "../../components/source-badge";
import { ModelUnavailableBadge } from "../../components/model-availability-badge";
import { DefaultCell } from "../../components/default-cell";
import { isModelUnpriced } from "./model-pricing";

/**
 * The model column set.
 *
 * Three columns, not four: the badges (source, disabled, unavailable, unpriced)
 * sit WITH the name rather than in a column of their own. They are attributes
 * of one model, not a dimension you read down the table, and a column for them
 * did not fit — this table lives in the settings modal, which is 775px wide, so
 * it never crosses the 56rem threshold and anything parked in tier 3 is never
 * drawn at all. Putting them in a tier-3 column cost more than space: the
 * unavailable badge is what EXPLAINS the disabled "set as default" control on
 * the same row, and hiding it left a dead control with no reason given.
 */
export function useModelColumns({
  registry,
  testingId,
  testResults,
  onTest,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingId: string | null;
  testResults: Record<string, TestResult | null>;
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
      width: "minmax(180px,1.6fr)",
      cell: (m) => {
        const ProviderIcon = getModelIcon(m, registry ?? []);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium">{m.label}</span>
                <span className="relative z-10 flex flex-wrap items-center gap-1.5">
                  <SourceBadge source={m.source} />
                  {m.aliased && <Badge variant="secondary">{t("models.alias")}</Badge>}
                  {m.source !== "built-in" && !m.enabled && (
                    <Badge variant="secondary" className="opacity-60">
                      {t("models.disabled")}
                    </Badge>
                  )}
                  {m.needs_reconnection && <ModelUnavailableBadge />}
                  {/* Pre-spend counterpart of the run's `cost_pricing_status`,
                      which only reports after the fact. Rule + exclusions live
                      in `model-pricing.ts`, where they are covered. */}
                  {isModelUnpriced(m) && (
                    <Badge variant="warning" title={t("models.unpricedHint")}>
                      {t("models.unpriced")}
                    </Badge>
                  )}
                </span>
              </div>
              <div className="text-muted-foreground truncate font-mono text-[0.65rem]">
                {m.aliased ? t("models.aliasHidden") : `${m.apiShape} / ${m.modelId}`}
              </div>
            </div>
          </div>
        );
      },
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
          disabled={m.needs_reconnection}
          testId={`set-default-model-${m.id}`}
        />
      ),
    },
    {
      id: "actions",
      header: "",
      width: "168px",
      align: "end",
      cell: (m) => (
        <div className="relative z-10 flex items-center justify-end gap-1">
          {testResults[m.id] && (
            <TestResultSpan
              result={testResults[m.id]!}
              successKey="models.testSuccess"
              failedKey="models.testFailed"
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onTest(m.id)}
            disabled={testingId === m.id}
          >
            {testingId === m.id ? <Spinner /> : t("models.test")}
          </Button>
          {m.source !== "built-in" && (
            <>
              {/* Aliases hide their real binding (modelId etc.), so the edit
                  form cannot round-trip them — the projected modelId is null
                  and would fail validation. Edit env/API-side; delete still
                  works, by id. */}
              {!m.aliased && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => onEdit(m)}
                  aria-label={t("models.edit")}
                >
                  <Pencil size={14} />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onDelete(m)}
                aria-label={t("models.delete")}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </>
          )}
        </div>
      ),
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
  testingId,
  testResults,
  onTest,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
}: {
  registry: ProviderRegistryEntry[] | undefined;
  testingId: string | null;
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
      width: "168px",
      align: "end",
      cell: (pk) => (
        <div className="relative z-10 flex items-center justify-end gap-1">
          {testResults[pk.id] && (
            <TestResultSpan
              result={testResults[pk.id]!}
              successKey="credentials.testSuccess"
              failedKey="credentials.testFailed"
            />
          )}
          {!isOauth(pk) && pk.source === "custom" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onTest(pk.id)}
                disabled={testingId === pk.id}
              >
                {testingId === pk.id ? <Spinner /> : t("credentials.test")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onEdit(pk)}
                aria-label={t("credentials.edit")}
              >
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onDelete(pk)}
                aria-label={t("credentials.delete")}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </>
          )}
          {isOauth(pk) && (
            <>
              {pk.needs_reconnection && pk.providerId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onConnectOAuth(pk)}
                >
                  {t("credentials.oauth.reconnect")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onDelete(pk)}
                aria-label={t("credentials.oauth.disconnect")}
              >
                <Trash2 size={14} className="text-destructive" />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];
}
