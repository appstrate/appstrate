// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePackageDetail, PACKAGE_CONFIG } from "../hooks/use-packages";
import { useCreatePackage, useUpdatePackage } from "../hooks/use-mutations";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import { useAuth } from "../hooks/use-auth";
import { useOrg, usePackageOwnership } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";
import { api } from "../api";
import { useUnsavedChanges } from "../hooks/use-unsaved-changes";
import { UnsavedChangesModal } from "../components/unsaved-changes-modal";

// Agent editor components
import { MetadataSection } from "../components/agent-editor/metadata-section";
import { SchemaSection } from "../components/agent-editor/schema-section";
import { ResourceSection } from "../components/agent-editor/resource-section";
import { PromptEditor } from "../components/agent-editor/prompt-editor";
import { ProviderPicker } from "../components/agent-editor/provider-picker";
import { JsonEditor } from "../components/json-editor";
import { ContentEditor } from "../components/package-editor/content-editor";
import { ProviderEditorInner } from "../components/provider-editor/provider-editor-inner";
import { Spinner } from "../components/spinner";
import { EditorShell } from "../components/editor-shell";
import { useProviders } from "../hooks/use-providers";

import type { AgentEditorState } from "../components/agent-editor/types";
import type { MetadataState } from "../components/agent-editor/metadata-section";
import {
  defaultEditorState,
  getManifestName,
  manifestToMetadata,
  metadataToManifestPatch,
  manifestToSchemaFields,
  getProviderEntries,
  setProviderEntries,
  getResourceEntries,
  setResourceEntries,
  toResourceEntry,
  fieldsToSchema,
} from "../components/agent-editor/utils";
import type { SchemaField } from "../components/agent-editor/schema-section";
import { agentSchema, skillSchema, toolSchema } from "@appstrate/core/schemas";
import type { PackageFormState } from "../lib/package-type-modules";
import { getPackageTypeModule } from "../lib/package-type-modules";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";

const PACKAGE_SCHEMAS: Record<string, object | undefined> = {
  agent: agentSchema,
  skill: skillSchema,
  tool: toolSchema,
};

type GenericEditorTab =
  | "general"
  | "prompt"
  | "providers"
  | "schema"
  | "skills"
  | "tools"
  | "content"
  | "json";

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  detail,
  packageId,
  isEdit,
}: {
  initialState: AgentEditorState;
  detail: { dependencies: { skills: unknown[]; tools: unknown[] }; lockVersion?: number } | null;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createFlow = useCreatePackage("agent");
  const updateFlow = useUpdatePackage("agent", packageId || "");

  const [state, setState] = useState<AgentEditorState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");
  const [jsonEditorKey, setJsonEditorKey] = useState(0);

  const updateManifest = (patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest: { ...s.manifest, ...patch } }));

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  // Schema fields are stored in local state to preserve fields being edited (empty key).
  // Only complete fields are persisted to the manifest via fieldsToSchema.
  const [schemaFields, setSchemaFields] = useState<Record<string, SchemaField[]>>(() =>
    manifestToSchemaFields(state.manifest),
  );

  const getSchemaFields = (key: "input" | "output" | "config") => schemaFields[key] ?? [];

  const onSchemaChange = (key: "input" | "output" | "config") => (fields: SchemaField[]) => {
    setSchemaFields((prev) => ({ ...prev, [key]: fields }));
    const wrapper = fieldsToSchema(fields, key);
    if (wrapper) {
      updateManifest({ [key]: wrapper });
    } else {
      setState((s) => {
        const { [key]: _, ...rest } = s.manifest;
        return { ...s, manifest: rest };
      });
    }
  };

  // --- Unsaved changes detection ---
  const isDirty = useMemo(
    () => JSON.stringify(initialState) !== JSON.stringify(state),
    [initialState, state],
  );
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !detail || !packageId) return;
    await api(`/packages/agents/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({
        manifest: state.manifest,
        content: state.prompt,
        lockVersion: detail.lockVersion!,
      }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
    qc.invalidateQueries({ queryKey: ["agents"] });
  }, [state, isEdit, detail, packageId, qc]);

  // Sync resolved skill/tool metadata from server (names, descriptions)
  useEffect(() => {
    if (!detail) return;
    setState((prev) => {
      const m = { ...prev.manifest };
      const skills = (
        detail.dependencies.skills as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry);
      const tools = (
        detail.dependencies.tools as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry);
      setResourceEntries(m, "skills", skills);
      setResourceEntries(m, "tools", tools);
      return { ...prev, manifest: m };
    });
  }, [detail]);

  const handleSubmit = () => {
    setError(null);
    const { id } = getManifestName(state.manifest);
    if (!id || !state.manifest.displayName) {
      setError(t("editor.errorRequired"));
      setActiveTab("general");
      return;
    }
    if (!state.prompt.trim()) {
      setError(t("editor.errorPrompt"));
      setActiveTab("prompt");
      return;
    }
    allowNavigation();
    const body = { manifest: state.manifest, content: state.prompt };
    if (isEdit && detail) {
      updateFlow.mutate(
        { ...body, lockVersion: detail.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createFlow.mutate(body, { onError: (err) => setError(err.message) });
    }
  };

  const isPending = createFlow.isPending || updateFlow.isPending;

  const agentTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "prompt", label: t("editor.tabPrompt") },
    { id: "providers", label: t("editor.tabServices") },
    { id: "schema", label: t("editor.tabSchema") },
    { id: "skills", label: t("editor.tabSkills") },
    { id: "tools", label: t("editor.tabTools") },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <EditorShell
      type="agent"
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.displayName as string) || packageId}
      tabs={agentTabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") setJsonEditorKey((k) => k + 1);
        setActiveTab(v as GenericEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={handleSubmit}
      onCancel={() => navigate(isEdit ? `/agents/${packageId}` : "/")}
      hideSubmitBar={activeTab === "json"}
    >
      {activeTab === "general" && (
        <MetadataSection value={metadata} onChange={onMetadataChange} isEdit={isEdit} />
      )}
      {activeTab === "prompt" && (
        <PromptEditor
          value={state.prompt}
          onChange={(prompt) => setState((s) => ({ ...s, prompt }))}
        />
      )}
      {activeTab === "providers" && (
        <ProviderPicker
          value={getProviderEntries(state.manifest)}
          onChange={(entries) => {
            const m = { ...state.manifest };
            setProviderEntries(m, entries);
            setState((s) => ({ ...s, manifest: m }));
          }}
        />
      )}
      {activeTab === "schema" && (
        <>
          <SchemaSection
            title={t("editor.inputTitle")}
            mode="input"
            fields={getSchemaFields("input")}
            onChange={onSchemaChange("input")}
          />
          <SchemaSection
            title={t("editor.outputTitle")}
            mode="output"
            fields={getSchemaFields("output")}
            onChange={onSchemaChange("output")}
          />
          <SchemaSection
            title={t("editor.configTitle")}
            mode="config"
            fields={getSchemaFields("config")}
            onChange={onSchemaChange("config")}
          />
        </>
      )}
      {activeTab === "skills" && (
        <ResourceSection
          type="skill"
          title={t("editor.tabSkills")}
          emptyLabel={t("editor.skillsEmpty")}
          selectedEntries={getResourceEntries(state.manifest, "skills")}
          onChange={(entries) => {
            const m = { ...state.manifest };
            setResourceEntries(m, "skills", entries);
            setState((s) => ({ ...s, manifest: m }));
          }}
        />
      )}
      {activeTab === "tools" && (
        <>
          {(
            state.manifest.output as
              | { schema?: { properties?: Record<string, unknown> } }
              | undefined
          )?.schema?.properties &&
            !getResourceEntries(state.manifest, "tools").some(
              (e) => e.id === "@appstrate/output",
            ) && (
              <Alert variant="warning" className="mb-4">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>{t("editor.outputToolWarning")}</AlertDescription>
              </Alert>
            )}
          <ResourceSection
            type="tool"
            title={t("editor.tabTools")}
            emptyLabel={t("editor.toolsEmpty")}
            selectedEntries={getResourceEntries(state.manifest, "tools")}
            onChange={(entries) => {
              const m = { ...state.manifest };
              setResourceEntries(m, "tools", entries);
              setState((s) => ({ ...s, manifest: m }));
            }}
          />
        </>
      )}
      {activeTab === "json" && (
        <JsonEditor
          key={jsonEditorKey}
          value={state.manifest}
          onApply={(manifest) => {
            setState((s) => ({ ...s, manifest }));
            setSchemaFields(manifestToSchemaFields(manifest));
            setActiveTab("general");
          }}
          schema={{ uri: AFPS_SCHEMA_URLS.agent, schema: PACKAGE_SCHEMAS.agent! }}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={isEdit ? saveDraft : undefined} />
    </EditorShell>
  );
}

// ─── Package (Skill/Tool) Editor Inner Form ─────────────────────────

function PackageEditorInner({
  type,
  initialState,
  packageId,
  isEdit,
}: {
  type: "skill" | "tool";
  initialState: PackageFormState;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createPkg = useCreatePackage(type);
  const updatePkg = useUpdatePackage(type, packageId || "");

  const [form, setForm] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");
  const [jsonEditorKey, setJsonEditorKey] = useState(0);

  // --- Unsaved changes detection ---
  const isDirty = useMemo(
    () => JSON.stringify(initialState) !== JSON.stringify(form),
    [initialState, form],
  );
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    const module = getPackageTypeModule(type);
    const payload = module.assemblePayload(form);
    const cfg = PACKAGE_CONFIG[type];
    await api(`/packages/${cfg.path}/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({ ...payload, lockVersion: form._lockVersion! }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
  }, [form, isEdit, type, packageId, qc]);

  if (form._type !== "skill" && form._type !== "tool") return null;

  const handleSubmit = () => {
    setError(null);
    const meta = form.metadata;
    if (!meta.id || !meta.displayName) {
      setError(t("editor.errorRequired"));
      setActiveTab("general");
      return;
    }
    if (!form.content.trim()) {
      setError(t("editor.errorContent", { defaultValue: "Le contenu est requis." }));
      setActiveTab("content");
      return;
    }

    allowNavigation();
    const module = getPackageTypeModule(type);
    const payload = module.assemblePayload(form);
    if (isEdit) {
      updatePkg.mutate({ ...payload, lockVersion: form._lockVersion! } as never, {
        onError: (err) => setError(err.message),
      });
    } else {
      createPkg.mutate({ id: meta.id, ...payload } as never, {
        onError: (err) => setError(err.message),
      });
    }
  };

  const isPending = createPkg.isPending || updatePkg.isPending;

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "content", label: t("packages.content") },
    { id: "json", label: t("editor.tabJson") },
  ];

  const language = type === "skill" ? "markdown" : "typescript";

  return (
    <EditorShell
      type={type}
      packageId={packageId}
      isEdit={isEdit}
      displayName={form.metadata.displayName || packageId}
      tabs={pkgTabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") setJsonEditorKey((k) => k + 1);
        setActiveTab(v as GenericEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={handleSubmit}
      onCancel={() =>
        navigate(isEdit ? packageDetailPath(type, packageId!) : packageListPath(type))
      }
      hideSubmitBar={activeTab === "json"}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={form.metadata}
          onChange={(metadata) => setForm((s) => ({ ...s, metadata }))}
          isEdit={isEdit}
        />
      )}

      {activeTab === "content" && (
        <ContentEditor
          value={form.content}
          onChange={(content) => setForm((s) => ({ ...s, content }))}
          language={language}
        />
      )}

      {activeTab === "json" && (
        <JsonEditor
          key={jsonEditorKey}
          value={
            (
              getPackageTypeModule(type).assemblePayload(form) as {
                manifest: Record<string, unknown>;
              }
            ).manifest
          }
          onApply={(parsed) => {
            const parsedName = getManifestName(parsed);
            setForm((s) => ({
              ...s,
              metadata: {
                ...s.metadata,
                displayName: (parsed.displayName as string) ?? s.metadata.displayName,
                description: (parsed.description as string) ?? s.metadata.description,
                version: (parsed.version as string) ?? s.metadata.version,
                ...(parsedName.scope ? { scope: parsedName.scope, id: parsedName.id } : {}),
              },
              _manifestBase: parsed,
            }));
            setActiveTab("general");
          }}
          schema={{ uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type]! }}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={isEdit ? saveDraft : undefined} />
    </EditorShell>
  );
}

// ─── Page Wrapper ───────────────────────────────────────────────────

export function PackageEditorPage({ type }: { type: PackageType }) {
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope ? `${scope}/${name}` : undefined;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const { isOwned } = usePackageOwnership(packageId);
  const isEdit = !!scope;

  // Load detail for editing
  const agentQuery = usePackageDetail("agent", type === "agent" && isEdit ? packageId : undefined);
  const pkgQuery = usePackageDetail(
    type,
    type !== "agent" && type !== "provider" && isEdit ? packageId : undefined,
  );
  const providersQuery = useProviders();

  const isLoading =
    type === "agent"
      ? agentQuery.isLoading
      : type === "provider"
        ? providersQuery.isLoading
        : pkgQuery.isLoading;
  const detail =
    type === "agent"
      ? agentQuery.data
      : type === "provider"
        ? providersQuery.data?.providers.find((p) => p.id === packageId)
        : pkgQuery.data;

  if (isEdit && isLoading) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (isEdit && !detail) {
    return <Navigate to="/agents" replace />;
  }

  if (isEdit && detail && (detail as { source?: string }).source === "system") {
    navigate(packageDetailPath(type, packageId!), { replace: true });
    return null;
  }

  if (isEdit && !isOwned) {
    navigate(packageDetailPath(type, packageId!), { replace: true });
    return null;
  }

  // Agent editor
  if (type === "agent") {
    const agentDetail = agentQuery.data;
    const initialState: AgentEditorState =
      isEdit && agentDetail
        ? {
            manifest: (agentDetail.manifest ?? {}) as Record<string, unknown>,
            prompt: agentDetail.prompt || "",
          }
        : defaultEditorState(currentOrg?.slug, user?.email);

    return (
      <AgentEditorInner
        key={packageId ?? "new"}
        initialState={initialState}
        detail={agentDetail ?? null}
        packageId={packageId}
        isEdit={isEdit}
      />
    );
  }

  // Provider editor — uses dedicated provider API
  if (type === "provider") {
    const editProvider = isEdit
      ? (providersQuery.data?.providers.find((p) => p.id === packageId) ?? null)
      : null;

    return (
      <ProviderEditorInner
        key={packageId ?? "new"}
        provider={editProvider}
        isEdit={isEdit}
        packageId={packageId}
        orgSlug={currentOrg?.slug}
      />
    );
  }

  // Skill/Tool editor (agent/provider returned early above — pkgQuery is always OrgPackageItemDetail here)
  const module = getPackageTypeModule(type);
  const pkgDetail = pkgQuery.data as OrgPackageItemDetail | undefined;

  const initialState: PackageFormState =
    isEdit && pkgDetail
      ? module.detailToFormState({
          id: pkgDetail.id,
          displayName: pkgDetail.name ?? pkgDetail.id,
          description: pkgDetail.description ?? "",
          source: pkgDetail.source ?? "local",
          version: pkgDetail.version,
          content: pkgDetail.content,
          updatedAt: pkgDetail.updatedAt,
          manifestName: pkgDetail.manifestName,
          lockVersion: pkgDetail.lockVersion,
        })
      : module.defaultFormState(currentOrg?.slug, user?.email);

  return (
    <PackageEditorInner
      key={packageId ?? "new"}
      type={type}
      initialState={initialState}
      packageId={packageId}
      isEdit={isEdit}
    />
  );
}
