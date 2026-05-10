// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BrainCircuit, ChevronDown, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { usePermissions } from "../../hooks/use-permissions";
import {
  useModels,
  useDeleteModel,
  useSetDefaultModel,
  useTestModel,
  useModelFormHandler,
} from "../../hooks/use-models";
import {
  useModelProviderCredentials,
  useCreateModelProviderCredential,
  useUpdateModelProviderCredential,
  useDeleteModelProviderCredential,
  useTestModelProviderCredential,
  deduplicateLabel,
} from "../../hooks/use-model-provider-credentials";
import { useConnectionTest } from "../../hooks/use-connection-test";
import { ModelFormModal } from "../../components/model-form-modal";
import { ModelProviderKeyFormModal } from "../../components/model-provider-credential-form-modal";
import { OAuthModelProviderDialog } from "../../components/oauth-model-provider-dialog";
import { cn } from "@/lib/utils";
import { PROVIDER_ICONS } from "../../components/icons";
import { findProviderByApiAndBaseUrl } from "../../lib/model-presets";
import { formatDateField } from "../../lib/markdown";
import { ConfirmModal } from "../../components/confirm-modal";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { Spinner } from "../../components/spinner";
import type { OrgModelInfo, OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";

function TestResultSpan({
  result,
  successKey,
  failedKey,
}: {
  result: TestResult;
  successKey: string;
  failedKey: string;
}) {
  const { t } = useTranslation(["settings"]);
  return (
    <span className={`text-sm ${result.ok ? "text-green-500" : "text-destructive"}`}>
      {result.ok
        ? t(successKey, { latency: result.latency })
        : t(failedKey, { message: result.message })}
    </span>
  );
}

function InlineEditableLabel({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editable || !editing) {
    return (
      <span
        className={cn("text-sm font-medium", editable && "cursor-pointer hover:underline")}
        onClick={() => {
          if (editable) {
            setDraft(value);
            setEditing(true);
          }
        }}
      >
        {value}
      </span>
    );
  }

  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
      }}
      className="h-7 w-auto min-w-40 text-sm font-medium"
    />
  );
}

function ModelsList({
  models,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onSetDefault,
  onRemoveDefault,
}: {
  models: OrgModelInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (m: OrgModelInfo) => void;
  onDelete: (m: OrgModelInfo) => void;
  onSetDefault: (m: OrgModelInfo) => void;
  onRemoveDefault: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModel();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button onClick={onCreate}>{t("models.add")}</Button>
      </div>

      {models && models.length > 0 ? (
        <div className="flex flex-col gap-3">
          {models.map((m) => {
            const isBuiltIn = m.source === "built-in";
            const provider = findProviderByApiAndBaseUrl(m.api, m.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            return (
              <div key={m.id} className="border-border bg-card rounded-lg border p-5">
                <div className="mb-3 flex items-center gap-3">
                  {ProviderIcon && <ProviderIcon className="size-5" />}
                  <div className="flex-1">
                    <h3 className="text-[0.95rem] font-semibold">{m.label}</h3>
                    <span className="text-muted-foreground text-sm">
                      {m.api} / {m.modelId}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {m.isDefault && <Badge variant="success">{t("models.default")}</Badge>}
                      {isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {t("models.builtIn")}
                        </Badge>
                      )}
                      {!isBuiltIn && (
                        <Badge variant="secondary" className="opacity-60">
                          {m.enabled ? t("models.enabled") : t("models.disabled")}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="border-border mt-3 flex items-center justify-end gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(m.id)}
                    disabled={testingId === m.id}
                  >
                    {testingId === m.id ? <Spinner /> : t("models.test")}
                  </Button>
                  {testResults[m.id] && (
                    <TestResultSpan
                      result={testResults[m.id]!}
                      successKey="models.testSuccess"
                      failedKey="models.testFailed"
                    />
                  )}
                  {m.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={onRemoveDefault}>
                      {t("models.removeDefault")}
                    </Button>
                  )}
                  {!m.isDefault && !isBuiltIn && (
                    <Button variant="outline" size="sm" onClick={() => onSetDefault(m)}>
                      {t("models.setDefault")}
                    </Button>
                  )}
                  {!isBuiltIn && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(m)}>
                        {t("models.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(m)}>
                        {t("models.delete")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState message={t("models.empty")} icon={BrainCircuit} compact>
          <Button onClick={onCreate}>{t("models.add")}</Button>
        </EmptyState>
      )}
    </>
  );
}

function ProviderKeysSection({
  providerKeys,
  isLoading,
  error,
  onCreate,
  onEdit,
  onDelete,
  onRename,
  onConnectOAuth,
}: {
  providerKeys: OrgModelProviderKeyInfo[] | undefined;
  isLoading: boolean;
  error: Error | null;
  onCreate: () => void;
  onEdit: (pk: OrgModelProviderKeyInfo) => void;
  onDelete: (pk: OrgModelProviderKeyInfo) => void;
  onRename: (pk: OrgModelProviderKeyInfo, newLabel: string) => void;
  onConnectOAuth: (providerPackageId: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const testMutation = useTestModelProviderCredential();
  const { testingId, testResults, handleTest } = useConnectionTest(testMutation);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          {t("providerKeys.add")} <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onCreate}>
          <KeyRound className="size-4" /> {t("providerKeys.add")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onConnectOAuth("@appstrate/provider-codex")}>
          {t("providerKeys.oauth.connectCodex")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onConnectOAuth("@appstrate/provider-claude-code")}>
          {t("providerKeys.oauth.connectClaude")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="mb-8">
      <div className="mb-4 flex items-center justify-end gap-2">{addMenu}</div>

      {providerKeys && providerKeys.length > 0 ? (
        <div className="border-border divide-border divide-y rounded-lg border">
          {providerKeys.map((pk) => {
            const provider = findProviderByApiAndBaseUrl(pk.api, pk.baseUrl);
            const ProviderIcon = provider ? PROVIDER_ICONS[provider.id] : undefined;
            const isOauth = pk.authMode === "oauth";
            return (
              <div key={pk.id} className="flex items-center gap-3 px-4 py-3">
                {ProviderIcon && <ProviderIcon className="text-muted-foreground size-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <InlineEditableLabel
                      value={pk.label}
                      editable={pk.source === "custom" && !isOauth}
                      onSave={(newLabel) => onRename(pk, newLabel)}
                    />
                    {isOauth && (
                      <Badge variant="secondary" className="text-[0.65rem]">
                        {t("providerKeys.oauth.badgeOauth")}
                      </Badge>
                    )}
                    {pk.needsReconnection && (
                      <Badge variant="destructive" className="text-[0.65rem]">
                        {t("providerKeys.oauth.needsReconnection")}
                      </Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                    <span>{pk.api}</span>
                    {pk.createdAt && (
                      <>
                        <span>&middot;</span>
                        <span>{formatDateField(pk.createdAt)}</span>
                      </>
                    )}
                    {isOauth && pk.oauthEmail && (
                      <>
                        <span>&middot;</span>
                        <span>{t("providerKeys.oauth.connectedAs", { email: pk.oauthEmail })}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {!isOauth && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTest(pk.id)}
                      disabled={testingId === pk.id}
                    >
                      {testingId === pk.id ? <Spinner /> : t("providerKeys.test")}
                    </Button>
                  )}
                  {testResults[pk.id] && (
                    <TestResultSpan
                      result={testResults[pk.id]!}
                      successKey="providerKeys.testSuccess"
                      failedKey="providerKeys.testFailed"
                    />
                  )}
                  {pk.source === "custom" && !isOauth && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => onEdit(pk)}>
                        {t("providerKeys.edit")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => onDelete(pk)}>
                        {t("providerKeys.delete")}
                      </Button>
                    </>
                  )}
                  {isOauth && (
                    <>
                      {pk.needsReconnection && pk.providerPackageId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onConnectOAuth(pk.providerPackageId!)}
                        >
                          {t("providerKeys.oauth.reconnect")}
                        </Button>
                      )}
                      <Button variant="destructive" size="sm" onClick={() => onDelete(pk)}>
                        {t("providerKeys.oauth.disconnect")}
                      </Button>
                    </>
                  )}
                  {pk.source === "built-in" && (
                    <span className="text-muted-foreground text-xs">{t("models.builtIn")}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          message={t("providerKeys.empty")}
          hint={t("providerKeys.emptyHint")}
          icon={KeyRound}
          compact
        >
          {addMenu}
        </EmptyState>
      )}
    </div>
  );
}

export function OrgSettingsModelsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();

  const [subTab, setSubTab] = useState<"models-list" | "provider-keys">("models-list");
  const [confirmState, setConfirmState] = useState<{
    type: "deleteModel" | "deleteProviderKey";
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
  const [editPk, setEditPk] = useState<OrgModelProviderKeyInfo | null>(null);
  const {
    data: providerKeys,
    isLoading: pkLoading,
    error: pkError,
  } = useModelProviderCredentials();
  const createPkMutation = useCreateModelProviderCredential();
  const updatePkMutation = useUpdateModelProviderCredential();
  const deletePkMutation = useDeleteModelProviderCredential();

  const [oauthDialogProviderId, setOauthDialogProviderId] = useState<string | null>(null);

  // Surface OAuth callback outcomes — `?connected=:providerKeyId` or `?error=...`.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get("oauthConnected");
    const error = searchParams.get("oauthError");
    if (connected) {
      toast.success(t("providerKeys.oauth.callbackSuccess"));
      const next = new URLSearchParams(searchParams);
      next.delete("oauthConnected");
      setSearchParams(next, { replace: true });
    } else if (error) {
      toast.error(t("providerKeys.oauth.callbackError", { error }));
      const next = new URLSearchParams(searchParams);
      next.delete("oauthError");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, t]);

  if (!isAdmin) return <Navigate to="/org-settings/general" replace />;

  return (
    <>
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "models-list" | "provider-keys")}>
        <TabsList className="mb-4">
          <TabsTrigger value="models-list">{t("models.tabTitle")}</TabsTrigger>
          <TabsTrigger value="provider-keys">{t("providerKeys.title")}</TabsTrigger>
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
          onSetDefault={(m) => setDefaultModelMutation.mutate(m.id)}
          onRemoveDefault={() => setDefaultModelMutation.mutate(null)}
        />
      )}

      {subTab === "provider-keys" && (
        <ProviderKeysSection
          providerKeys={providerKeys}
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
            setConfirmState({ type: "deleteProviderKey", label: pk.label, id: pk.id })
          }
          onRename={(pk, newLabel) => {
            updatePkMutation.mutate({ id: pk.id, data: { label: newLabel } });
          }}
          onConnectOAuth={(providerPackageId) => setOauthDialogProviderId(providerPackageId)}
        />
      )}

      {oauthDialogProviderId && (
        <OAuthModelProviderDialog
          open
          providerPackageId={oauthDialogProviderId}
          defaultLabel={
            oauthDialogProviderId === "@appstrate/provider-codex"
              ? "ChatGPT"
              : oauthDialogProviderId === "@appstrate/provider-claude-code"
                ? "Claude"
                : "OAuth provider"
          }
          onClose={() => setOauthDialogProviderId(null)}
        />
      )}

      <ModelFormModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        model={editModel}
        isPending={modelForm.isPending}
        onSubmit={modelForm.onSubmit}
      />

      <ModelProviderKeyFormModal
        open={pkModalOpen}
        onClose={() => setPkModalOpen(false)}
        providerKey={editPk}
        isPending={createPkMutation.isPending || updatePkMutation.isPending}
        onSubmit={(data) => {
          if (editPk) {
            // The PUT body only accepts mutable fields — `api`/`baseUrl` are
            // pinned by `providerId` at create time. Strip them here even
            // though the form disables those inputs on edit.
            const patch: { label?: string; apiKey?: string } = { label: data.label };
            if (data.apiKey) patch.apiKey = data.apiKey;
            updatePkMutation.mutate(
              { id: editPk.id, data: patch },
              { onSuccess: () => setPkModalOpen(false) },
            );
          } else {
            const uniqueLabel = deduplicateLabel(data.label, providerKeys ?? []);
            createPkMutation.mutate(
              { ...data, label: uniqueLabel } as {
                label: string;
                api: string;
                baseUrl: string;
                apiKey: string;
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
            : confirmState?.type === "deleteProviderKey"
              ? t("providerKeys.deleteConfirm", { label: confirmState.label })
              : ""
        }
        isPending={deleteModelMutation.isPending || deletePkMutation.isPending}
        onConfirm={() => {
          if (!confirmState) return;
          const close = () => setConfirmState(null);
          if (confirmState.type === "deleteModel") {
            deleteModelMutation.mutate(confirmState.id, { onSuccess: close });
          } else {
            deletePkMutation.mutate(confirmState.id, { onSuccess: close });
          }
        }}
      />
    </>
  );
}
