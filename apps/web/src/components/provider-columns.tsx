// SPDX-License-Identifier: Apache-2.0

/**
 * The column set of the providers table (Settings › Models, Preferences › My providers).
 *
 * The rows are `ProviderRow`s (`lib/model-providers.ts`): a key or the instance, and the
 * models it makes usable. One State column says what is worth saying (`rowStates`), nothing
 * when all is well. Everything a row can do is in its « … » menu; a click on an organization key's row chooses
 * its models. Another person's key names its holder under its own name.
 */

import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
  CheckCircle2,
  FlaskConical,
  KeyRound,
  ListChecks,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { useTestModel, type OrgModelInfo } from "../hooks/use-models";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import { useConnectionTest, type TestResult } from "../hooks/use-connection-test";
import type { DataColumn } from "./data-table";
import { getProviderIcon } from "./icons";
import { resolveProviderEntry } from "../lib/provider-registry-helpers";
import { rowStates, type ProviderKind, type ProviderRow } from "../lib/model-providers";
import { TestResultSpan } from "./test-result-span";
import { TableRowActions } from "./table-row-actions";
import { rowActionsColumn } from "./row-actions-column";
import { CellText } from "./table-cells";
import { InlineEditableLabel } from "./inline-editable-label";
import { ModelsCell } from "./provider-models-cell";
import { RowStateCell } from "./row-state-cell";
import { ModelTestResult } from "./model-form/model-test-result";
import { authStore } from "../stores/auth-store";

/** What the caller may do with a credential row: the server's verdict (`allowed_actions`). */
function allowed(
  pk: ModelProviderCredentialInfo,
  action: ModelProviderCredentialInfo["allowed_actions"][number],
): boolean {
  return pk.allowed_actions.includes(action);
}

function useTypeText() {
  const { t } = useTranslation("settings");
  return (kind: ProviderKind) =>
    ({
      "org-key": t("modelPicker.kind.org"),
      "personal-key": t("providers.type.personalKey"),
      subscription: t("providers.type.subscription"),
      system: t("providers.type.system"),
    })[kind];
}

export interface ProviderColumnsArgs {
  registry: ProviderRegistryEntry[] | undefined;
  testingIds: ReadonlySet<string>;
  testResults: Record<string, TestResult | null>;
  /** The row whose name is being edited in place. */
  renamingId: string | null;
  onRenamingChange: (id: string | null) => void;
  onTest: (id: string) => void;
  onRename: (pk: ModelProviderCredentialInfo, label: string) => Promise<void>;
  /** Only the organization's page chooses models and sets the default. */
  onChooseModels?: (pk: ModelProviderCredentialInfo) => void;
  onChangeKey: (pk: ModelProviderCredentialInfo) => void;
  onReconnect: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onSetDefault?: (m: OrgModelInfo) => void;
  /** The instance's own aliases (`source: "custom"`): absent when the caller may not delete. */
  onDeleteModel?: (m: OrgModelInfo) => void;
  /** Resolved once by the page: a deed absent here 403s if clicked. */
  canWriteModels: boolean;
  /** Preferences lists personal keys of two kinds, a key or a subscription: it says which. */
  showType?: boolean;
}

/** The providers table's columns: a key (or the instance), its service, its models, its state. */
export function useProviderColumns({
  registry,
  testingIds,
  testResults,
  renamingId,
  onRenamingChange,
  onTest,
  onRename,
  onChooseModels,
  onChangeKey,
  onReconnect,
  onDelete,
  onSetDefault,
  onDeleteModel,
  canWriteModels,
  showType = false,
}: ProviderColumnsArgs): DataColumn<ProviderRow>[] {
  const { t } = useTranslation(["settings", "common"]);
  const typeText = useTypeText();
  const entries = registry ?? [];
  const userId = useStore(authStore, (s) => s.user?.id);
  // The instance's models are tested one by one, from its row's menu.
  const modelTest = useConnectionTest(useTestModel());

  const columns: DataColumn<ProviderRow>[] = [
    {
      id: "provider",
      header: t("spaces.nameLabel"),
      width: 110,
      elastic: true,
      cell: (row) => {
        const pk = row.credential;
        const Icon =
          row.kind === "system"
            ? null
            : getProviderIcon(
                pk
                  ? resolveProviderEntry(pk, entries)
                  : entries.find((p) => p.providerId === row.serviceIds[0]),
              );
        const result = testResults[row.id];
        const label =
          row.kind === "system" ? t("providers.type.system") : row.label || t("spaces.nameLabel");
        return (
          <div className="flex min-w-0 items-center gap-2">
            {Icon ? (
              <Icon className="text-muted-foreground size-4 shrink-0" />
            ) : row.kind === "system" ? (
              <Server className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <KeyRound className="text-muted-foreground size-4 shrink-0" />
            )}
            <div className="min-w-0">
              {pk && allowed(pk, "edit") ? (
                <InlineEditableLabel
                  value={pk.label}
                  editable
                  editing={renamingId === pk.id}
                  onEditingChange={(editing) => onRenamingChange(editing ? pk.id : null)}
                  onSave={(next) => onRename(pk, next)}
                />
              ) : (
                <CellText strong title={label}>
                  {label}
                </CellText>
              )}
              {/* Mes clés holds keys and subscriptions together: the kind reads under the name,
                  where no width tier can hide it. */}
              {showType && <CellText>{typeText(row.kind)}</CellText>}
              {pk?.owner_type === "user" && pk.owner_id !== userId && pk.owner_name && (
                <CellText title={pk.owner_name}>{pk.owner_name}</CellText>
              )}
              {pk?.oauth_email && <CellText title={pk.oauth_email}>{pk.oauth_email}</CellText>}
              {result && (
                <div className="relative z-10">
                  <TestResultSpan
                    result={result}
                    successKey="credentials.testSuccess"
                    failedKey="credentials.testFailed"
                  />
                </div>
              )}
              {row.kind === "system" &&
                row.models.map((m) => {
                  const modelResult = modelTest.testResults[m.id];
                  return modelResult ? (
                    <div key={m.id} className="relative z-10 flex min-w-0 items-baseline gap-1.5">
                      <span className="text-muted-foreground shrink-0 text-xs">{m.label}</span>
                      <ModelTestResult result={modelResult} />
                    </div>
                  ) : null;
                })}
            </div>
          </div>
        );
      },
    },
    {
      id: "service",
      header: t("providers.col.provider"),
      width: 90,
      elastic: true,
      tier: 2,
      cell: (row) => {
        // The instance spans several services: its row says where its models come from.
        const text = row.serviceName ?? (row.kind === "system" ? t("providers.instanceName") : "—");
        return (
          <span className="block truncate text-sm" title={text}>
            {text}
          </span>
        );
      },
    },
    {
      id: "models",
      header: t("providers.col.models"),
      width: 100,
      elastic: true,
      cell: (row) => (
        <ModelsCell
          models={row.models}
          registry={entries}
          serviceIds={row.kind === "system" ? row.serviceIds : undefined}
        />
      ),
    },
    {
      id: "state",
      header: t("providers.col.state"),
      // A badge or two: the room it does not need goes to the name and models.
      width: 100,
      elastic: true,
      tier: 2,
      cell: (row) => (
        <RowStateCell
          states={rowStates(row)}
          unavailableHint={
            row.credential?.authMode === "oauth2" ? undefined : t("credentials.unavailableHint")
          }
        />
      ),
    },
    rowActionsColumn((row) => {
      const pk = row.credential;
      const isTesting = testingIds.has(row.id);
      if (row.kind === "system") {
        const choices = canWriteModels ? row.models.filter((m) => !m.is_default) : [];
        // An alias has no test: its result would describe the backing it hides.
        const testable = canWriteModels ? row.models.filter((m) => !m.aliased) : [];
        // An alias the organization added is its own row: it is deleted by id.
        const deletable = onDeleteModel ? row.models.filter((m) => m.source !== "built-in") : [];
        if (choices.length + testable.length + deletable.length === 0) return null;
        return (
          <TableRowActions
            menuLabel={t("providers.moreActions", { name: t("providers.type.system") })}
            isPending={testable.some((m) => modelTest.testingIds.has(m.id))}
          >
            {choices.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <CheckCircle2 />
                  {t("providers.chooseDefault")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {choices.map((m) => (
                    <DropdownMenuItem
                      key={m.id}
                      onSelect={() => onSetDefault?.(m)}
                      // The server refuses a dead credential and a switched-off alias; it
                      // resolves a switched-off built-in model.
                      disabled={m.needs_reconnection || (m.source !== "built-in" && !m.enabled)}
                      data-testid={`set-default-model-${m.id}`}
                    >
                      {m.label}
                      {!m.enabled && (
                        <span className="text-muted-foreground ml-auto text-xs">
                          {t("providers.state.disabled")}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {testable.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FlaskConical />
                  {t("models.test")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {testable.map((m) => (
                    <DropdownMenuItem
                      key={m.id}
                      onSelect={() => void modelTest.handleTest(m.id)}
                      disabled={modelTest.testingIds.has(m.id)}
                    >
                      {m.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {deletable.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="text-destructive focus:text-destructive">
                    <Trash2 />
                    {t("btn.delete", { ns: "common" })}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {deletable.map((m) => (
                      <DropdownMenuItem
                        key={m.id}
                        onSelect={() => onDeleteModel?.(m)}
                        data-testid={`delete-model-${m.id}`}
                      >
                        {m.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </TableRowActions>
        );
      }
      if (!pk) return null;
      const canRename = allowed(pk, "edit");
      const canChangeKey = canRename && pk.authMode !== "oauth2";
      const canReconnect =
        allowed(pk, "reconnect") && pk.needs_reconnection === true && !!pk.providerId;
      const canChoose = row.kind === "org-key" && canWriteModels;
      return (
        <TableRowActions
          menuLabel={t("providers.moreActions", { name: pk.label })}
          isPending={isTesting}
          renaming={renamingId === pk.id}
          actions={[
            {
              id: "rename",
              label: t("btn.rename", { ns: "common" }),
              icon: Pencil,
              onSelect: () => onRenamingChange(pk.id),
              hidden: !canRename,
            },
            {
              id: "choose-models",
              label: t("models.choice.title"),
              icon: ListChecks,
              onSelect: () => onChooseModels?.(pk),
              hidden: !canChoose,
            },
            {
              id: "change-key",
              label: t("credentials.edit"),
              icon: KeyRound,
              onSelect: () => onChangeKey(pk),
              hidden: !canChangeKey,
            },
            {
              id: "reconnect",
              label: t("credentials.oauth.reconnect"),
              icon: RefreshCw,
              onSelect: () => onReconnect(pk),
              hidden: !canReconnect,
            },
            {
              id: "test",
              label: t("credentials.test"),
              icon: FlaskConical,
              onSelect: () => onTest(pk.id),
              disabled: isTesting,
              hidden: !allowed(pk, "test"),
            },
            {
              id: "delete",
              label: t("credentials.delete"),
              icon: Trash2,
              onSelect: () => onDelete(pk),
              destructive: true,
              hidden: !allowed(pk, "delete"),
            },
          ]}
        />
      );
    }),
  ];
  return columns;
}
