// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BrainCircuit, KeyRound, Pencil, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useModels,
  useDeleteModel,
  useSetDefaultModel,
  useTestModel,
  useModelFormHandler,
  type OrgModelInfo,
} from "../../hooks/use-models";
import {
  useModelProviderCredentials,
  useCreateModelProviderCredential,
  useUpdateModelProviderCredential,
  useDeleteModelProviderCredential,
  useTestModelProviderCredential,
  useProvidersRegistry,
  deduplicateLabel,
  type ModelProviderCredentialInfo,
} from "../../hooks/use-model-provider-credentials";
import { getErrorMessage } from "@appstrate/core/errors";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { ModelFormModal } from "../../components/model-form-modal";
import { CredentialFormModal } from "../../components/credential-form-modal";
import { getModelIcon, getProviderIcon } from "../../components/icons";
import { findProviderByApiShapeAndBaseUrl } from "../../lib/provider-registry-helpers";
import { formatDateField } from "../../lib/format-date";
import { ConfirmModal } from "../../components/confirm-modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import { TestResultSpan } from "../../components/test-result-span";
import { InlineEditableLabel } from "../../components/inline-editable-label";
import { SourceBadge } from "../../components/source-badge";
import { ModelUnavailableBadge } from "../../components/model-availability-badge";
import { DefaultCell } from "../../components/default-cell";
import { isModelUnpriced } from "./model-pricing";

function ModelsList({
  models,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  models: OrgModelInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModel();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("models.add")}</Button>
      </div>

      {models && models.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("models.col.source")}</TableHead>
                <TableHead className="text-xs">{t("models.col.model")}</TableHead>
                <TableHead className="text-xs">{t("models.col.default")}</TableHead>
                <TableHead className="w-px text-right text-xs">{t("models.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => {
                const isBuiltIn = m.source === "built-in";
                // Pre-spend counterpart of the run's `cost_pricing_status`,
                // which only reports after the fact. Rule + exclusions live in
                // `model-pricing.ts`, where they are covered.
                const isUnpriced = isModelUnpriced(m);
                const ProviderIcon = getModelIcon(m, registry ?? []);
                return (
                  <TableRow key={m.id} data-testid={`model-row-${m.id}`}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SourceBadge source={m.source} />
                        {m.aliased && <Badge variant="secondary">{t("models.alias")}</Badge>}
                        {!isBuiltIn && !m.enabled && (
                          <Badge variant="secondary" className="opacity-60">
                            {t("models.disabled")}
                          </Badge>
                        )}
                        {m.needs_reconnection && <ModelUnavailableBadge />}
                        {isUnpriced && (
                          <Badge variant="warning" title={t("models.unpricedHint")}>
                            {t("models.unpriced")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{m.label}</div>
                          <div className="text-muted-foreground font-mono text-[0.65rem]">
                            {m.aliased ? t("models.aliasHidden") : `${m.apiShape} / ${m.modelId}`}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* Shown but disabled, not hidden: `PUT /api/models/default`
                          answers 409 `model_needs_reconnection` for such a row,
                          and a control that silently vanishes is what made this
                          state impossible to reason about. The why is on the
                          row's `ModelUnavailableBadge` (first cell), whose
                          `title` sits on a hoverable element. */}
                      <DefaultCell
                        isDefault={m.is_default}
                        defaultLabel={t("models.default")}
                        setLabel={t("models.setDefault")}
                        onSetDefault={() => onSetDefault(m)}
                        disabled={m.needs_reconnection}
                        testId={`set-default-model-${m.id}`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Aliases expose no connection test. The result
                            (`{ ok, latency, status }`) is measured against the
                            hidden backing, so it would report that vendor's
                            round-trip time and upstream status to a user who is
                            never told which vendor it is. The route refuses it
                            server-side too (400) — this only keeps the UI from
                            offering a button that cannot work. Same posture as
                            the edit button below. */}
                        {!m.aliased && (
                          <>
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
                              onClick={() => handleTest(m.id)}
                              disabled={testingId === m.id}
                            >
                              {testingId === m.id ? <Spinner /> : t("models.test")}
                            </Button>
                          </>
                        )}
                        {!isBuiltIn && (
                          <>
                            {/* Aliases hide their real binding (modelId etc.),
                                so the edit form can't round-trip them — the
                                projected modelId is null and would fail
                                validation. Edit env/API-side; delete still
                                works (by id). */}
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState message={t("models.empty")} icon={BrainCircuit} compact>
          <Button onClick={onCreate}>{t("models.add")}</Button>
        </EmptyState>
      )}
    </>
  );
}

function CredentialsSection({
  credentials,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
}: {
  credentials: ModelProviderCredentialInfo[] | undefined;
  isLoading: boolean;
  error: unknown;
  onCreate: () => void;
  onEdit: (pk: ModelProviderCredentialInfo) => void;
  onDelete: (pk: ModelProviderCredentialInfo) => void;
  onRename: (pk: ModelProviderCredentialInfo, newLabel: string) => void;
  onConnectOAuth: (credential: ModelProviderCredentialInfo) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);
  const { data: registry } = useProvidersRegistry();

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;

  // Single entry point — the unified modal handles both API-key and OAuth
  // flows. Removing a module from `MODULES` hides its OAuth tile from the
  // in-modal provider picker with zero UI footprint here.
  const addButton = <Button onClick={onCreate}>{t("credentials.add")}</Button>;

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center justify-end gap-2">{addButton}</div>

      {credentials && credentials.length > 0 ? (
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("credentials.col.provider")}</TableHead>
                <TableHead className="text-xs">{t("credentials.col.auth")}</TableHead>
                <TableHead className="text-xs">{t("credentials.col.created")}</TableHead>
                <TableHead className="text-xs">{t("credentials.col.status")}</TableHead>
                <TableHead className="w-px text-right text-xs">
                  {t("credentials.col.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map((pk) => {
                const provider = findProviderByApiShapeAndBaseUrl(
                  pk.apiShape,
                  pk.baseUrl,
                  registry ?? [],
                );
                const ProviderIcon = getProviderIcon(provider);
                const isOauth = pk.authMode === "oauth2";
                return (
                  <TableRow key={pk.id} data-testid={`credential-row-${pk.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {ProviderIcon && (
                          <ProviderIcon className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <InlineEditableLabel
                            value={pk.label}
                            editable={pk.source === "custom" && !isOauth}
                            onSave={(newLabel) => onRename(pk, newLabel)}
                          />
                          {isOauth && pk.oauth_email && (
                            <div className="text-muted-foreground truncate text-[0.65rem]">
                              {t("credentials.oauth.connectedAs", { email: pk.oauth_email })}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {isOauth ? (
                        <Badge variant="secondary">{t("credentials.oauth.badgeOauth")}</Badge>
                      ) : (
                        <SourceBadge source={pk.source} />
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {pk.createdAt ? formatDateField(pk.createdAt) : "—"}
                    </TableCell>
                    <TableCell>
                      {pk.needs_reconnection ? (
                        // The flag also fires on a stored secret that no longer
                        // decrypts, which reaches api-key credentials — where
                        // the fix is to re-enter the key (Edit), not to
                        // reconnect an account.
                        <Badge variant="destructive">
                          {isOauth
                            ? t("credentials.oauth.needsReconnection")
                            : t("models.credentialUnavailable")}
                        </Badge>
                      ) : pk.source === "built-in" ? (
                        <span className="text-muted-foreground text-xs">{t("source.builtIn")}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {testResults[pk.id] && (
                          <TestResultSpan
                            result={testResults[pk.id]!}
                            successKey="credentials.testSuccess"
                            failedKey="credentials.testFailed"
                          />
                        )}
                        {!isOauth && pk.source === "custom" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleTest(pk.id)}
                            disabled={testingId === pk.id}
                          >
                            {testingId === pk.id ? <Spinner /> : t("credentials.test")}
                          </Button>
                        )}
                        {pk.source === "custom" && !isOauth && (
                          <>
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
                        {isOauth && (
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
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          message={t("credentials.empty")}
          hint={t("credentials.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addButton}
        </EmptyState>
      )}
    </div>
  );
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();

  const [subTab, setSubTab] = useState<"models-list" | "credentials">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteCredential";
    label: string;
    id: string;
  } | null>(null);

  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [editModel, setEditModel] = useState<OrgModelInfo | null>(null);
  const { data: models, isLoading: modelsLoading, error: modelsError } = useModels();
  const deleteModelMutation = useDeleteModel();
  const setDefaultModelMutation = useSetDefaultModel();
  const modelForm = useModelFormHandler({
    editModel,
    onSuccess: () => setModelModalOpen(false),
  });

  const [pkModalOpen, setPkModalOpen] = useState(false);
  const [editPk, setEditPk] = useState<ModelProviderCredentialInfo | null>(null);
  const { data: credentials, isLoading: pkLoading, error: pkError } = useModelProviderCredentials();
  const createPkMutation = useCreateModelProviderCredential();
  const updatePkMutation = useUpdateModelProviderCredential();
  const deletePkMutation = useDeleteModelProviderCredential();

  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;

  return (
    <>
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "models-list" | "credentials")}>
        <TabsList className="mb-4">
          <TabsTrigger value="models-list">{t("models.tabTitle")}</TabsTrigger>
          <TabsTrigger value="credentials">{t("credentials.title")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {subTab === "models-list" && (
        <ModelsList
          models={models}
          isLoading={modelsLoading}
          error={modelsError}
          onCreate={() => {
            setEditModel(null);
            setModelModalOpen(true);
          }}
          onEdit={(m) => {
            setEditModel(m);
            setModelModalOpen(true);
          }}
          onDelete={(m) => setConfirmState({ type: "deleteModel", label: m.label, id: m.id })}
          onSetDefault={(m) => setDefaultModelMutation.mutate({ body: { modelId: m.id } })}
        />
      )}

      {subTab === "credentials" && (
        <CredentialsSection
          credentials={credentials}
          isLoading={pkLoading}
          error={pkError}
          onCreate={() => {
            setEditPk(null);
            setPkModalOpen(true);
          }}
          onEdit={(pk) => {
            setEditPk(pk);
            setPkModalOpen(true);
          }}
          onDelete={(pk) =>
            setConfirmState({ type: "deleteCredential", label: pk.label, id: pk.id })
          }
          onRename={(pk, newLabel) => {
            updatePkMutation.mutate({
              params: { path: { id: pk.id } },
              body: { label: newLabel },
            });
          }}
          onConnectOAuth={(credential) => {
            setEditPk(credential);
            setPkModalOpen(true);
          }}
        />
      )}

      <ModelFormModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        model={editModel}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <CredentialFormModal
        open={pkModalOpen}
        onClose={() => setPkModalOpen(false)}
        credential={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
        onSubmit={(data) => {
          if (editPk) {
            // The PUT body only accepts mutable fields — `api`/`baseUrl` are
            // pinned by `providerId` at create time. Strip them here even
            // though the form disables those inputs on edit.
            const patch: { label?: string; apiKey?: string } = { label: data.label };
            if (data.apiKey) patch.apiKey = data.apiKey;
            updatePkMutation.mutate(
              { params: { path: { id: editPk.id } }, body: patch },
              { onSuccess: () => setPkModalOpen(false) },
            );
          } else {
            const uniqueLabel = deduplicateLabel(data.label, credentials ?? []);
            createPkMutation.mutate(
              {
                body: {
                  label: uniqueLabel,
                  providerId: data.providerId,
                  apiKey: data.apiKey ?? "",
                  ...(data.baseUrlOverride ? { baseUrlOverride: data.baseUrlOverride } : {}),
                },
              },
              { onSuccess: () => setPkModalOpen(false) },
            );
          }
        }}
      />

      <ConfirmModal
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        title={t("btn.confirm", { ns: "common" })}
        description={
          confirmState?.type === "deleteModel"
            ? t("models.deleteConfirm", { label: confirmState.label })
            : confirmState?.type === "deleteCredential"
              ? t("credentials.deleteConfirm", { label: confirmState.label })
              : ""
        }
        isPending={deleteModelMutation.isPending || deletePkMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          const close = () => setConfirmState(null);
          if (confirmState.type === "deleteModel") {
            deleteModelMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              { onSuccess: close },
            );
          } else {
            deletePkMutation.mutate(
              { params: { path: { id: confirmState.id } } },
              { onSuccess: close },
            );
          }
        }}
      />
    </>
  );
}
