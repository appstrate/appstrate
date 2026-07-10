// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePackageDetail } from "../hooks/use-packages";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";
import { primaryDisplayFile } from "../lib/package-files";
import { useEditorState, type EditorStateBase } from "../hooks/use-editor-state";
import { UnsavedChangesModal } from "../components/unsaved-changes-modal";
import { FormField } from "../components/form-field";

// Agent editor components
import { MetadataSection } from "../components/agent-editor/metadata-section";
import { SchemaSection } from "../components/agent-editor/schema-section";
import { ResourceSection } from "../components/agent-editor/resource-section";
import { RuntimeToolsGroup } from "../components/agent-editor/runtime-tools-group";
import { PromptEditor } from "../components/agent-editor/prompt-editor";
import { JsonEditor } from "../components/json-editor";
import { ContentEditor } from "../components/package-editor/content-editor";
import { SourceSection } from "../components/integration-editor/source-section";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { ToolsPolicySection } from "../components/integration-editor/tools-policy-section";
import { Spinner } from "../components/spinner";
import { EditorShell } from "../components/editor-shell";

import type { AgentEditorState } from "../components/agent-editor/types";
import type { MetadataState } from "../components/agent-editor/metadata-section";
import {
  defaultEditorState,
  defaultSkillManifest,
  defaultIntegrationManifest,
  DEFAULT_SKILL_CONTENT,
  getManifestName,
  manifestToMetadata,
  metadataToManifestPatch,
  manifestToSchemaFields,
  getResourceEntries,
  setResourceEntries,
  getRuntimeTools,
  setRuntimeTools,
  toResourceEntry,
  fieldsToSchema,
} from "../components/agent-editor/utils";
import type { SchemaField } from "../components/agent-editor/schema-section";
import { agentSchema, skillSchema, integrationSchema } from "@appstrate/core/schemas";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";

const PACKAGE_SCHEMAS: Record<string, object | undefined> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
};

type GenericEditorTab =
  | "general"
  | "prompt"
  | "schema"
  | "skills"
  | "integrations"
  | "source"
  | "auths"
  | "tools"
  | "content"
  | "json";

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  resolvedDeps,
  packageId,
  isEdit,
}: {
  initialState: AgentEditorState;
  resolvedDeps: { skills: unknown[] } | null;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");

  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
  } = useEditorState<AgentEditorState>({
    initialState,
    packageType: "agent",
    packageId,
    isEdit,
    toWireBody: (s) => ({ manifest: s.manifest, content: s.prompt }),
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (!s.prompt.trim()) {
        return { error: t("editor.errorPrompt"), tab: "prompt" };
      }
      return null;
    },
  });

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

  // Sync resolved skill metadata from server (names, descriptions)
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
      setResourceEntries(m, "skills", skills);
      return { ...prev, manifest: m };
    });
  }, [resolvedDeps, setState]);

  const onSubmit = () =>
    handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

  const agentTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "prompt", label: primaryDisplayFile("agent").name },
    { id: "schema", label: t("editor.tabSchema") },
    { id: "skills", label: t("editor.tabSkills") },
    { id: "integrations", label: t("editor.tabIntegrations") },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <EditorShell
      type="agent"
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.display_name as string) || packageId}
      tabs={agentTabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") bumpJsonKey();
        setActiveTab(v as GenericEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={onSubmit}
      onCancel={() => navigate(isEdit ? `/agents/${packageId}` : "/")}
      hideSubmitBar={activeTab === "json"}
    >
      {activeTab === "general" && (
        <MetadataSection value={metadata} onChange={onMetadataChange} isEdit={isEdit}>
          <FormField
            id="meta-timeout"
            label={t("editor.execTimeout")}
            type="number"
            min={1}
            value={typeof state.manifest.timeout === "number" ? String(state.manifest.timeout) : ""}
            onChange={(v) => {
              const n = parseInt(v, 10);
              // `undefined` clears the key through the shallow manifest merge
              // (JSON serialization drops it on save → server default, 300s).
              updateManifest({ timeout: Number.isNaN(n) ? undefined : n });
            }}
            placeholder="300"
            description={t("editor.execTimeoutDesc")}
          />
        </MetadataSection>
      )}
      {activeTab === "prompt" && (
        <PromptEditor
          value={state.prompt}
          onChange={(prompt) => setState((s) => ({ ...s, prompt }))}
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
          onChange={(updater) => {
            setState((s) => {
              const prev = getResourceEntries(s.manifest, "skills");
              const next = typeof updater === "function" ? updater(prev) : updater;
              const m = { ...s.manifest };
              setResourceEntries(m, "skills", next);
              return { ...s, manifest: m };
            });
          }}
        />
      )}
      {activeTab === "integrations" && (
        <ResourceSection
          type="integration"
          title={t("editor.tabIntegrations")}
          emptyLabel={t("editor.integrationsEmpty")}
          selectedEntries={getResourceEntries(state.manifest, "integrations")}
          onChange={(updater) => {
            setState((s) => {
              const prev = getResourceEntries(s.manifest, "integrations");
              const next = typeof updater === "function" ? updater(prev) : updater;
              const m = { ...s.manifest };
              setResourceEntries(m, "integrations", next);
              return { ...s, manifest: m };
            });
          }}
          leadingItems={
            <RuntimeToolsGroup
              selected={getRuntimeTools(state.manifest)}
              onChange={(next) => {
                setState((s) => {
                  const m = { ...s.manifest };
                  setRuntimeTools(m, next);
                  return { ...s, manifest: m };
                });
              }}
            />
          }
        />
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

interface PackageEditorState extends EditorStateBase {
  content: string;
}

function PackageEditorInner({
  type,
  initialState,
  packageId,
  isEdit,
}: {
  type: "skill";
  initialState: PackageEditorState;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");

  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
  } = useEditorState<PackageEditorState>({
    initialState,
    packageType: type,
    packageId,
    isEdit,
    toWireBody: (s) => ({
      manifest: s.manifest,
      content: s.content,
    }),
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (!s.content.trim()) {
        return {
          error: t("editor.errorContent", { defaultValue: "Le contenu est requis." }),
          tab: "content",
        };
      }
      return null;
    },
  });

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "content", label: primaryDisplayFile(type).name },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <EditorShell
      type={type}
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.display_name as string) || packageId}
      tabs={pkgTabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") bumpJsonKey();
        setActiveTab(v as GenericEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={onSubmit}
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

// ─── Integration Editor Inner Form ──────────────────────────────────

function IntegrationEditorInner({
  initialState,
  packageId,
  isEdit,
}: {
  initialState: EditorStateBase;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");

  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
  } = useEditorState<EditorStateBase>({
    initialState,
    packageType: "integration",
    packageId,
    isEdit,
    // The manifest is the source of truth; `manifest.json` storage content
    // mirrors it for export/bundle portability (runtime reads the DB manifest).
    toWireBody: (s) => ({
      manifest: s.manifest,
      content: JSON.stringify(s.manifest, null, 2),
    }),
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      return null;
    },
  });

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

  const onManifestChange = (manifest: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest }));

  const integrationTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "source", label: t("integrationEditor.tabSource") },
    { id: "auths", label: t("integrationEditor.tabAuths") },
    { id: "tools", label: t("integrationEditor.tabTools") },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <EditorShell
      type="integration"
      packageId={packageId}
      isEdit={isEdit}
      displayName={(state.manifest.display_name as string) || packageId}
      tabs={integrationTabs}
      activeTab={activeTab}
      onTabChange={(v) => {
        if (v === "json") bumpJsonKey();
        setActiveTab(v as GenericEditorTab);
      }}
      error={error}
      isPending={isPending}
      onSubmit={onSubmit}
      onCancel={() =>
        navigate(
          isEdit ? packageDetailPath("integration", packageId!) : packageListPath("integration"),
        )
      }
      hideSubmitBar={activeTab === "json"}
    >
      {activeTab === "general" && (
        <MetadataSection value={metadata} onChange={onMetadataChange} isEdit={isEdit} />
      )}

      {activeTab === "source" && (
        <SourceSection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "auths" && (
        <AuthsSection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "tools" && (
        <ToolsPolicySection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "json" && (
        <JsonEditor
          key={jsonEditorKey}
          value={state.manifest}
          onApply={(manifest) => {
            setState((s) => ({ ...s, manifest }));
            setActiveTab("general");
          }}
          schema={{ uri: AFPS_SCHEMA_URLS.integration, schema: PACKAGE_SCHEMAS.integration! }}
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
  const isEdit = !!scope;

  // Load detail for editing
  const agentQuery = usePackageDetail("agent", type === "agent" && isEdit ? packageId : undefined);
  const pkgQuery = usePackageDetail(type, type !== "agent" && isEdit ? packageId : undefined);

  const isLoading = type === "agent" ? agentQuery.isLoading : pkgQuery.isLoading;
  const detail = type === "agent" ? agentQuery.data : pkgQuery.data;

  if (isEdit && isLoading) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center p-6 py-16">
        <Spinner />
      </div>
    );
  }

  if (isEdit && !detail) {
    return <Navigate to="/agents" replace />;
  }

  // Only system packages are read-only. Org-owned packages are editable regardless of their
  // scope name (registry integrity checks happen at publish time, not local edit).
  if (isEdit && detail && (detail as { source?: string }).source === "system") {
    navigate(packageDetailPath(type, packageId!), { replace: true });
    return null;
  }

  // Agent editor
  if (type === "agent") {
    const agentDetail = agentQuery.data;
    const initialState: AgentEditorState =
      isEdit && agentDetail
        ? {
            manifest: agentDetail.manifest ?? {},
            prompt: agentDetail.prompt || "",
            lock_version: agentDetail.lock_version,
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

  // Integration editor — manifest-only (General + raw JSON tabs). Bundle-backed
  // `source.kind: "local"` integrations still arrive via import; this editor
  // authors `remote`/`none` sources.
  if (type === "integration") {
    const intDetail = pkgQuery.data as OrgPackageItemDetail | undefined;
    const initialState: EditorStateBase =
      isEdit && intDetail
        ? {
            manifest: intDetail.manifest ?? {},
            lock_version: intDetail.lock_version,
          }
        : { manifest: defaultIntegrationManifest(currentOrg?.slug, user?.email) };

    return (
      <IntegrationEditorInner
        key={packageId ?? "new"}
        initialState={initialState}
        packageId={packageId}
        isEdit={isEdit}
      />
    );
  }

  // Skill editor (agent/integration returned early above — pkgQuery is always OrgPackageItemDetail here)
  const pkgDetail = pkgQuery.data as OrgPackageItemDetail | undefined;

  const initialState: PackageEditorState =
    isEdit && pkgDetail
      ? {
          manifest: pkgDetail.manifest ?? {},
          content: pkgDetail.content ?? "",
          lock_version: pkgDetail.lock_version,
        }
      : {
          manifest: defaultSkillManifest(currentOrg?.slug, user?.email),
          content: DEFAULT_SKILL_CONTENT,
        };

  return (
    <PackageEditorInner
      key={packageId ?? "new"}
      type="skill"
      initialState={initialState}
      packageId={packageId}
      isEdit={isEdit}
    />
  );
}
