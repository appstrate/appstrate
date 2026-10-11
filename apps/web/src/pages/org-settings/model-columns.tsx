// SPDX-License-Identifier: Apache-2.0

/**
 * The column sets of the model and provider tables, out of the pages they are
 * drawn on.
 *
 * A column set is data, not a screen, and the other three already live beside
 * their table rather than inside a page. Here there is a second reason: the
 * page imports the credential modal, which reaches an `@/…` alias the test
 * runner does not resolve, so a set left in the page could not be held to
 * `column-tiers.test.tsx` at all — and a set that is not in that test inherits
 * the tier rule without being checked against it.
 *
 * Organization › Models is ONE grouped table: a group per provider of the
 * organization, its models as the rows under it. The columns are the models'
 * (`useModelColumns`); what a group's own row shows in each of them is
 * `useModelGroupCell`.
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CheckCircle2, FlaskConical, KeyRound, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import type { OrgModelInfo } from "../../hooks/use-models";
import type { ModelProviderCredentialInfo } from "../../hooks/use-model-provider-credentials";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials";
import type { TestResult } from "../../hooks/use-connection-test";
import type { DataColumn } from "../../components/data-table";
import { getModelIcon, getProviderIcon } from "../../components/icons";
import {
  findProviderByApiShapeAndBaseUrl,
  getProviderById,
} from "../../lib/provider-registry-helpers";
import { isModelEditable, type ModelGroup } from "../../lib/model-groups";
import { TestResultSpan } from "../../components/test-result-span";
import { TableRowActions } from "../../components/table-row-actions";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { ModelUnavailableBadge } from "../../components/model-availability-badge";
import { isModelUnpriced } from "./model-pricing";

/** What the caller may do with a credential row: the server's verdict (`allowed_actions`). */
function allowed(
  pk: ModelProviderCredentialInfo,
  action: ModelProviderCredentialInfo["allowed_actions"][number],
): boolean {
  return pk.allowed_actions.includes(action);
}

/** The service icon of a credential, from its provider when it names one. */
function credentialIcon(
  pk: ModelProviderCredentialInfo,
  registry: readonly ProviderRegistryEntry[],
) {
  return getProviderIcon(
    (pk.providerId ? getProviderById(pk.providerId, registry) : undefined) ??
      findProviderByApiShapeAndBaseUrl(pk.apiShape, pk.base_url, registry),
  );
}

/** The word that says what kind of access a credential is. */
function useCredentialTypeText() {
  const { t } = useTranslation("settings");
  return (pk: ModelProviderCredentialInfo) =>
    pk.source === "built-in"
      ? t("source.builtIn")
      : pk.authMode === "oauth2"
        ? t("credentials.subscription")
        : t("credentials.apiKey");
}

/** A credential's status: a fresh test result, else whether it can still serve. */
function credentialStatus(
  pk: ModelProviderCredentialInfo,
  testResult: TestResult | null | undefined,
  t: TFunction<["settings", "common"]>,
): ReactNode {
  if (testResult) {
    return (
      <TestResultSpan
        result={testResult}
        successKey="credentials.testSuccess"
        failedKey="credentials.testFailed"
      />
    );
  }
  if (pk.needs_reconnection) {
    // The flag also fires on a stored secret that no longer decrypts, which reaches api-key
    // credentials — where the fix is to re-enter the key (Edit), not to reconnect an account.
    const oauth = pk.authMode === "oauth2";
    return (
      <Badge variant="failed" title={oauth ? undefined : t("credentials.unavailableHint")}>
        {oauth ? t("credentials.oauth.needsReconnection") : t("models.credentialUnavailable")}
      </Badge>
    );
  }
  return <Badge variant="success">{t("credentials.available")}</Badge>;
}

interface ModelColumnsArgs {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  settingDefaultId: string | null;
  /** The model whose switch on / off is in flight. */
  togglingId: string | null;
  /** The row whose name is being edited in place (a model's or a provider's id). */
  renamingId: string | null;
  onRenamingChange: (id: string | null) => void;
  onTest: (id: string) => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  onRename: (m: OrgModelInfo, label: string) => Promise<void>;
  onToggleEnabled: (m: OrgModelInfo) => void;
  /** Resolved once by the page: a row action absent here 403s if clicked. */
  canWrite: boolean;
  canDelete: boolean;
}

/** The models' columns: the rows of every group. */
export function useModelColumns({
  registry,
  testingIds,
  testResults,
  settingDefaultId,
  togglingId,
  renamingId,
  onRenamingChange,
  onTest,
  onEdit,
  onDelete,
  onSetDefault,
  onRename,
  onToggleEnabled,
  canWrite,
  canDelete,
}: ModelColumnsArgs): DataColumn<OrgModelInfo>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "name",
      header: t("models.col.name"),
      width: "minmax(220px,1.6fr)",
      cell: (m) => {
        const ProviderIcon = getModelIcon(m, registry ?? []);
        const editable = isModelEditable(m, canWrite);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
            <div className="min-w-0">
              <div className="relative z-10 w-fit max-w-full min-w-0">
                <InlineEditableLabel
                  value={m.label}
                  editable={editable}
                  editing={renamingId === m.id}
                  onEditingChange={(editing) => onRenamingChange(editing ? m.id : null)}
                  onSave={(label) => onRename(m, label)}
                />
              </div>
              {/* A model each person serves with their own provider says which service. */}
              {m.binding === "member" && m.provider_name && (
                <span
                  className="text-muted-foreground block truncate text-xs"
                  title={m.provider_name}
                >
                  {m.provider_name}
                </span>
              )}
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
      id: "modelId",
      header: t("models.col.modelId"),
      width: "minmax(140px,1fr)",
      tier: 3,
      cell: (m) =>
        m.modelId ? (
          <span
            className="text-muted-foreground relative z-10 block w-fit max-w-full truncate font-mono text-xs"
            title={m.modelId}
          >
            {m.modelId}
          </span>
        ) : null,
    },
    {
      id: "type",
      header: t("models.col.type"),
      width: "76px",
      tier: 3,
      // Only a provider's own row has a type (the models under it share it).
      cell: () => null,
    },
    {
      id: "default",
      header: t("models.col.default"),
      width: "88px",
      tier: 3,
      cell: (m) =>
        m.is_default ? (
          <Badge variant="success">{t("models.default")}</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        ),
    },
    {
      id: "status",
      header: t("models.col.status"),
      width: "minmax(100px,1fr)",
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
      id: "actions",
      header: "",
      width: "64px",
      align: "end",
      cell: (m) => {
        const isTesting = testingIds.has(m.id);
        const isBusy = isTesting || settingDefaultId === m.id || togglingId === m.id;
        const isCustom = m.source !== "built-in";
        const editable = isModelEditable(m, canWrite);
        return (
          <TableRowActions
            menuLabel={t("models.moreActions", { name: m.label })}
            isPending={isBusy}
            pendingLabel={t("common:loading")}
            renaming={renamingId === m.id}
          >
            {editable && (
              <>
                <DropdownMenuItem onSelect={() => onEdit(m)}>
                  <Pencil />
                  {t("models.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRenamingChange(m.id)}>
                  <Pencil />
                  {t("btn.rename", { ns: "common" })}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => onTest(m.id)} disabled={isTesting}>
              <FlaskConical />
              {t("models.test")}
            </DropdownMenuItem>
            {canWrite && !m.is_default && (
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
            {editable && (
              <DropdownMenuItem onSelect={() => onToggleEnabled(m)} disabled={togglingId !== null}>
                <Power />
                {m.enabled ? t("models.disable") : t("models.enable")}
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
        );
      },
    },
  ];
}

interface ModelGroupCellArgs {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  renamingId: string | null;
  onRenamingChange: (id: string | null) => void;
  onTest: (id: string) => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, label: string) => Promise<void>;
  onAddModel: (pk: ModelProviderCredentialInfo) => void;
  canWriteModels: boolean;
}

/** What a group's own row shows, per column of `useModelColumns`. */
export function useModelGroupCell({
  registry,
  testingIds,
  testResults,
  renamingId,
  onRenamingChange,
  onTest,
  onEdit,
  onDelete,
  onRename,
  onAddModel,
  canWriteModels,
}: ModelGroupCellArgs): (group: ModelGroup, columnId: string) => ReactNode {
  const { t } = useTranslation(["settings", "common"]);
  const typeText = useCredentialTypeText();

  return (group, columnId) => {
    if (group.kind !== "provider") {
      // These groups have no cell of their own beyond the name, which the table spans.
      if (columnId !== "name") return null;
      const personal = group.kind === "personal";
      return (
        <div className="min-w-0 py-1">
          <span className="block truncate text-sm font-medium">
            {personal ? t("models.group.personal") : t("models.group.system")}
          </span>
          <span className="text-muted-foreground block text-xs">
            {personal ? t("models.group.personalHint") : t("models.group.systemHint")}
          </span>
        </div>
      );
    }

    const pk = group.credential;
    if (!pk) {
      // A provider the caller cannot read: named by its service, nothing to act on.
      return columnId === "name" ? (
        <span className="truncate text-sm font-medium">
          {group.serviceName ?? t("models.col.provider")}
        </span>
      ) : null;
    }

    const isTesting = testingIds.has(pk.id);
    switch (columnId) {
      case "name": {
        const Icon = credentialIcon(pk, registry ?? []);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? (
              <Icon className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <KeyRound className="text-muted-foreground size-4 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="relative z-10 w-fit max-w-full min-w-0">
                <InlineEditableLabel
                  value={pk.label}
                  editable={allowed(pk, "edit")}
                  editing={renamingId === pk.id}
                  onEditingChange={(editing) => onRenamingChange(editing ? pk.id : null)}
                  onSave={(label) => onRename(pk, label)}
                />
              </div>
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
      }
      case "type":
        return <span className="text-muted-foreground block truncate text-xs">{typeText(pk)}</span>;
      case "status":
        return (
          <div className="relative z-10 min-w-0">{credentialStatus(pk, testResults[pk.id], t)}</div>
        );
      case "actions": {
        const canChangeKey = allowed(pk, "edit") && pk.authMode !== "oauth2";
        return (
          <TableRowActions
            menuLabel={t("credentials.moreActions", { name: pk.label })}
            isPending={isTesting}
            pendingLabel={t("common:loading")}
            renaming={renamingId === pk.id}
          >
            {allowed(pk, "edit") && (
              <DropdownMenuItem onSelect={() => onRenamingChange(pk.id)}>
                <Pencil />
                {t("btn.rename", { ns: "common" })}
              </DropdownMenuItem>
            )}
            {canChangeKey && (
              <DropdownMenuItem onSelect={() => onEdit(pk)}>
                <KeyRound />
                {t("credentials.edit")}
              </DropdownMenuItem>
            )}
            {allowed(pk, "test") && (
              <DropdownMenuItem onSelect={() => onTest(pk.id)} disabled={isTesting}>
                <FlaskConical />
                {t("credentials.test")}
              </DropdownMenuItem>
            )}
            {canWriteModels && pk.bindable && (
              <DropdownMenuItem onSelect={() => onAddModel(pk)}>
                <Plus />
                {t("models.add")}
              </DropdownMenuItem>
            )}
            {allowed(pk, "delete") && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(pk)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 />
                  {t("credentials.delete")}
                </DropdownMenuItem>
              </>
            )}
          </TableRowActions>
        );
      }
      default:
        return null;
    }
  };
}

interface CredentialColumnsArgs {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  /** The row whose name is being edited in place. */
  renamingId: string | null;
  onRenamingChange: (id: string | null) => void;
  onTest: (id: string) => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => Promise<void>;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
}

/** The caller's own providers (Preferences): every deed is in the row's menu. */
export function useCredentialColumns({
  registry,
  testingIds,
  testResults,
  renamingId,
  onRenamingChange,
  onTest,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
}: CredentialColumnsArgs): DataColumn<ModelProviderCredentialInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  const typeText = useCredentialTypeText();

  return [
    {
      id: "provider",
      header: t("credentials.col.provider"),
      width: "minmax(96px,1.4fr)",
      cell: (pk) => {
        const ProviderIcon = credentialIcon(pk, registry ?? []);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
            <div className="min-w-0">
              <div className="relative z-10 w-fit max-w-full min-w-0">
                <InlineEditableLabel
                  value={pk.label}
                  // The one rename, for a key and for a subscription alike.
                  editable={pk.source === "custom" && allowed(pk, "edit")}
                  editing={renamingId === pk.id}
                  onEditingChange={(editing) => onRenamingChange(editing ? pk.id : null)}
                  onSave={(newLabel) => onRename(pk, newLabel)}
                />
              </div>
              {pk.oauth_email && (
                <span
                  className="text-muted-foreground block truncate text-xs"
                  title={pk.oauth_email}
                >
                  {pk.oauth_email}
                </span>
              )}
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
    {
      id: "type",
      header: t("credentials.col.type"),
      width: "96px",
      tier: 2,
      cell: (pk) => (
        <span className="text-muted-foreground block truncate text-xs">{typeText(pk)}</span>
      ),
    },
    {
      id: "status",
      header: t("credentials.col.status"),
      width: "minmax(96px,1fr)",
      tier: 2,
      cell: (pk) => credentialStatus(pk, testResults[pk.id], t),
    },
    {
      id: "actions",
      header: "",
      width: "64px",
      align: "end",
      cell: (pk) => {
        const oauth = pk.authMode === "oauth2";
        // Reconnecting is the holder's own act (the helper pairs an account to them); the server
        // allows it on any own subscription, the row offers it once the subscription fails.
        const canReconnect =
          allowed(pk, "reconnect") && pk.needs_reconnection && Boolean(pk.providerId);
        const canEditKey = !oauth && pk.source === "custom" && allowed(pk, "edit");
        const canRename = pk.source === "custom" && allowed(pk, "edit");
        const canTest = allowed(pk, "test");
        const canDelete = allowed(pk, "delete");
        const isTesting = testingIds.has(pk.id);
        if (!canRename && !canEditKey && !canReconnect && !canTest && !canDelete) return null;
        return (
          <TableRowActions
            menuLabel={t("credentials.moreActions", { name: pk.label })}
            isPending={isTesting}
            pendingLabel={t("common:loading")}
            renaming={renamingId === pk.id}
          >
            {canRename && (
              <DropdownMenuItem onSelect={() => onRenamingChange(pk.id)}>
                <Pencil />
                {t("btn.rename", { ns: "common" })}
              </DropdownMenuItem>
            )}
            {canEditKey && (
              <DropdownMenuItem onSelect={() => onEdit(pk)}>
                <KeyRound />
                {t("credentials.edit")}
              </DropdownMenuItem>
            )}
            {canReconnect && (
              <DropdownMenuItem onSelect={() => onConnectOAuth(pk)}>
                <Pencil />
                {t("credentials.oauth.reconnect")}
              </DropdownMenuItem>
            )}
            {canTest && (
              <DropdownMenuItem onSelect={() => onTest(pk.id)} disabled={isTesting}>
                <FlaskConical />
                {t("credentials.test")}
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onDelete(pk)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 />
                  {oauth ? t("credentials.oauth.disconnect") : t("credentials.delete")}
                </DropdownMenuItem>
              </>
            )}
          </TableRowActions>
        );
      },
    },
  ];
}

interface MemberProviderColumnsArgs {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  onTest: (id: string) => void;
  /** The caller's id: their own rows say « vous ». */
  userId: string | undefined;
}

/** The members' own providers, read by an administrator: only the holder changes one. */
export function useMemberProviderColumns({
  registry,
  testingIds,
  testResults,
  onTest,
  userId,
}: MemberProviderColumnsArgs): DataColumn<ModelProviderCredentialInfo>[] {
  const { t } = useTranslation(["settings", "common"]);
  const typeText = useCredentialTypeText();

  return [
    {
      id: "owner",
      header: t("credentials.col.owner"),
      width: "minmax(100px,1fr)",
      cell: (pk) => {
        const you = userId !== undefined && pk.owner_id === userId;
        const name = pk.owner_name ?? "—";
        return (
          <span className="block min-w-0 truncate text-sm font-medium" title={name}>
            {name}
            {you && (
              <span className="text-muted-foreground font-normal"> ({t("credentials.you")})</span>
            )}
          </span>
        );
      },
    },
    {
      id: "provider",
      header: t("credentials.col.service"),
      width: "minmax(120px,1.2fr)",
      cell: (pk) => {
        const Icon = credentialIcon(pk, registry ?? []);
        return (
          <div className="flex min-w-0 items-center gap-2">
            {Icon && <Icon className="text-muted-foreground size-4 shrink-0" />}
            <div className="min-w-0">
              <span className="block truncate text-sm" title={pk.label}>
                {pk.label}
              </span>
              {pk.oauth_email && (
                <span
                  className="text-muted-foreground block truncate text-xs"
                  title={pk.oauth_email}
                >
                  {pk.oauth_email}
                </span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "type",
      header: t("credentials.col.type"),
      width: "80px",
      tier: 2,
      cell: (pk) => (
        <span className="text-muted-foreground block truncate text-xs">{typeText(pk)}</span>
      ),
    },
    {
      id: "status",
      header: t("credentials.col.status"),
      width: "minmax(88px,1fr)",
      tier: 2,
      cell: (pk) => credentialStatus(pk, testResults[pk.id], t),
    },
    {
      id: "actions",
      header: "",
      width: "64px",
      align: "end",
      cell: (pk) => {
        if (!allowed(pk, "test")) return null;
        const isTesting = testingIds.has(pk.id);
        return (
          <TableRowActions
            menuLabel={t("credentials.moreActions", { name: pk.label })}
            isPending={isTesting}
            pendingLabel={t("common:loading")}
          >
            <DropdownMenuItem onSelect={() => onTest(pk.id)} disabled={isTesting}>
              <FlaskConical />
              {t("credentials.test")}
            </DropdownMenuItem>
          </TableRowActions>
        );
      },
    },
  ];
}
