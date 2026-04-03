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

import type { AgentEditorState } from "../components/agent-editor/types";
import type { MetadataState } from "../components/agent-editor/metadata-section";
import {
  defaultEditorState,
  defaultSkillManifest,
  defaultToolManifest,
  defaultProviderManifest,
  DEFAULT_SKILL_CONTENT,
  DEFAULT_TOOL_CONTENT,
  DEFAULT_TOOL_SOURCE,
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
  | "source"
  | "json";

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  resolvedDeps,
  packageId,
  isEdit,
}: {
  initialState: AgentEditorState;
  resolvedDeps: { skills: unknown[]; tools: unknown[] } | null;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createAgent = useCreatePackage("agent");
  const updateAgent = useUpdatePackage("agent", packageId || "");

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
    if (!isEdit || !packageId) return;
    const cfg = PACKAGE_CONFIG.agent;
    await api(`/packages/${cfg.path}/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({
        manifest: state.manifest,
        content: state.prompt,
        lockVersion: state.lockVersion!,
      }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
    qc.invalidateQueries({ queryKey: ["agents"] });
  }, [state, isEdit, packageId, qc]);

  // Sync resolved skill/tool metadata from server (names, descriptions)
  useEffect(() => {
    if (!resolvedDeps) return;
    setState((prev) => {
      const m = { ...prev.manifest };
      const skills = (
        resolvedDeps.skills as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry);
      const tools = (
        resolvedDeps.tools as {
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
  }, [resolvedDeps]);

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
    if (isEdit) {
      updateAgent.mutate(
        { ...body, lockVersion: state.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createAgent.mutate(body, { onError: (err) => setError(err.message) });
    }
  };

  const isPending = createAgent.isPending || updateAgent.isPending;

  const agentTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "prompt", label: t("editor.tabContent.agent") },
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

interface PackageEditorState {
  manifest: Record<string, unknown>;
  content: string;
  sourceCode?: string;
  lockVersion?: number;
}

function PackageEditorInner({
  type,
  initialState,
  packageId,
  isEdit,
}: {
  type: "skill" | "tool";
  initialState: PackageEditorState;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const createPkg = useCreatePackage(type);
  const updatePkg = useUpdatePackage(type, packageId || "");

  const [state, setState] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");
  const [jsonEditorKey, setJsonEditorKey] = useState(0);

  const updateManifest = (patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest: { ...s.manifest, ...patch } }));

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  // --- Unsaved changes detection ---
  const isDirty = useMemo(
    () => JSON.stringify(initialState) !== JSON.stringify(state),
    [initialState, state],
  );
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);

  const saveDraft = useCallback(async () => {
    if (!isEdit || !packageId) return;
    const cfg = PACKAGE_CONFIG[type];
    await api(`/packages/${cfg.path}/${packageId}`, {
      method: "PUT",
      body: JSON.stringify({
        manifest: state.manifest,
        content: state.content,
        ...(state.sourceCode !== undefined ? { sourceCode: state.sourceCode } : {}),
        lockVersion: state.lockVersion!,
      }),
    });
    qc.invalidateQueries({ queryKey: ["packages"] });
  }, [state, isEdit, type, packageId, qc]);

  const handleSubmit = () => {
    setError(null);
    const { id } = getManifestName(state.manifest);
    if (!id || !state.manifest.displayName) {
      setError(t("editor.errorRequired"));
      setActiveTab("general");
      return;
    }
    if (type === "skill" && !state.content.trim()) {
      setError(t("editor.errorContent", { defaultValue: "Le contenu est requis." }));
      setActiveTab("content");
      return;
    }
    if (type === "tool" && !state.sourceCode?.trim()) {
      setError(t("editor.errorContent", { defaultValue: "Le contenu est requis." }));
      setActiveTab("source");
      return;
    }

    allowNavigation();
    const body = {
      manifest: state.manifest,
      content: state.content,
      ...(state.sourceCode !== undefined ? { sourceCode: state.sourceCode } : {}),
    };
    if (isEdit) {
      updatePkg.mutate(
        { ...body, lockVersion: state.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createPkg.mutate(body, { onError: (err) => setError(err.message) });
    }
  };

  const isPending = createPkg.isPending || updatePkg.isPending;

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "content", label: t(`editor.tabContent.${type}`) },
    ...(type === "tool"
      ? [{ id: "source" as GenericEditorTab, label: t("editor.tabSource") }]
      : []),
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <EditorShell
      type={type}
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.displayName as string) || packageId}
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
        <MetadataSection value={metadata} onChange={onMetadataChange} isEdit={isEdit} />
      )}

      {activeTab === "content" && (
        <ContentEditor
          value={state.content}
          onChange={(content) => setState((s) => ({ ...s, content }))}
          language="markdown"
        />
      )}

      {activeTab === "source" && type === "tool" && (
        <ContentEditor
          value={state.sourceCode ?? ""}
          onChange={(sourceCode) => setState((s) => ({ ...s, sourceCode }))}
          language="typescript"
        />
      )}

      {activeTab === "json" && (
        <JsonEditor
          key={jsonEditorKey}
          value={state.manifest}
          onApply={(manifest) => {
            setState((s) => ({ ...s, manifest }));
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
  const pkgQuery = usePackageDetail(type, type !== "agent" && isEdit ? packageId : undefined);

  const isLoading = type === "agent" ? agentQuery.isLoading : pkgQuery.isLoading;
  const detail = type === "agent" ? agentQuery.data : pkgQuery.data;

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
            lockVersion: agentDetail.lockVersion,
          }
        : defaultEditorState(currentOrg?.slug, user?.email);

    return (
      <AgentEditorInner
        key={packageId ?? "new"}
        initialState={initialState}
        resolvedDeps={agentDetail?.dependencies ?? null}
        packageId={packageId}
        isEdit={isEdit}
      />
    );
  }

  // Provider editor — uses package detail (manifest as source of truth)
  if (type === "provider") {
    const providerDetail = pkgQuery.data as OrgPackageItemDetail | undefined;

    return (
      <ProviderEditorInner
        key={packageId ?? "new"}
        initialState={
          isEdit && providerDetail
            ? {
                manifest: providerDetail.manifest ?? {},
                content: providerDetail.content ?? "",
                lockVersion: providerDetail.lockVersion,
              }
            : { manifest: defaultProviderManifest(currentOrg?.slug, user?.email), content: "" }
        }
        isEdit={isEdit}
        packageId={packageId}
      />
    );
  }

  // Skill/Tool editor (agent/provider returned early above — pkgQuery is always OrgPackageItemDetail here)
  const pkgDetail = pkgQuery.data as OrgPackageItemDetail | undefined;

  const defaultManifest =
    type === "tool"
      ? defaultToolManifest(currentOrg?.slug, user?.email)
      : defaultSkillManifest(currentOrg?.slug, user?.email);
  const defaultContent = type === "tool" ? DEFAULT_TOOL_CONTENT : DEFAULT_SKILL_CONTENT;

  const initialState: PackageEditorState =
    isEdit && pkgDetail
      ? {
          manifest: pkgDetail.manifest ?? {},
          content: pkgDetail.content ?? "",
          ...(type === "tool" ? { sourceCode: pkgDetail.sourceCode ?? "" } : {}),
          lockVersion: pkgDetail.lockVersion,
        }
      : {
          manifest: defaultManifest,
          content: defaultContent,
          ...(type === "tool" ? { sourceCode: DEFAULT_TOOL_SOURCE } : {}),
        };

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
