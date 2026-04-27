// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePackageDetail, usePackageList } from "../hooks/use-packages";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import { useAuth } from "../hooks/use-auth";
import { useOrg, usePackageOwnership } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";
import { useEditorState } from "../hooks/use-editor-state";
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
  DEFAULT_SYSTEM_TOOL_IDS,
  caretRange,
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
      if (!id || !s.manifest.displayName) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (!s.prompt.trim()) {
        return { error: t("editor.errorPrompt"), tab: "prompt" };
      }
      return null;
    },
  });

  // Pre-populate the platform's "stdlib" tools (log/output/pin/note)
  // once on first mount in create mode, after the registry's package list
  // resolves. We resolve caret ranges from the canonical version here
  // instead of hardcoding `*` placeholders in `defaultEditorState` and
  // migrating later — that earlier approach raced when multiple
  // `VersionSelect` instances tried to migrate in the same React batch.
  // The `populated` ref makes this a one-shot: removing a system tool
  // afterwards must not re-add it.
  const { data: toolsList } = usePackageList("tool");
  const populatedRef = useRef(false);
  useEffect(() => {
    if (populatedRef.current) return;
    if (isEdit) return;
    if (!toolsList || toolsList.length === 0) return;

    const presetTools: Record<string, string> = {};
    for (const id of DEFAULT_SYSTEM_TOOL_IDS) {
      const item = toolsList.find((i) => i.id === id);
      if (item?.version) {
        presetTools[id] = caretRange(item.version);
      }
    }
    populatedRef.current = true;
    if (Object.keys(presetTools).length === 0) return;

    setState((s) => {
      const m = { ...s.manifest };
      const deps = { ...((m.dependencies as Record<string, unknown> | undefined) ?? {}) };
      const existing = (deps.tools as Record<string, string> | undefined) ?? {};
      // Don't override anything the user has already touched (e.g. a
      // toggle/version pick that landed before the items list resolved).
      deps.tools = { ...presetTools, ...existing };
      m.dependencies = deps;
      return { ...s, manifest: m };
    });
  }, [isEdit, toolsList, setState]);

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
  }, [resolvedDeps, setState]);

  const onSubmit = () =>
    handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

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
            onChange={(updater) => {
              setState((s) => {
                const prev = getResourceEntries(s.manifest, "tools");
                const next = typeof updater === "function" ? updater(prev) : updater;
                const m = { ...s.manifest };
                setResourceEntries(m, "tools", next);
                return { ...s, manifest: m };
              });
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
      ...(s.sourceCode !== undefined ? { sourceCode: s.sourceCode } : {}),
    }),
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id || !s.manifest.displayName) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (type === "skill" && !s.content.trim()) {
        return {
          error: t("editor.errorContent", { defaultValue: "Le contenu est requis." }),
          tab: "content",
        };
      }
      if (type === "tool" && !s.sourceCode?.trim()) {
        return {
          error: t("editor.errorContent", { defaultValue: "Le contenu est requis." }),
          tab: "source",
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
      <div className="text-muted-foreground flex flex-col items-center justify-center p-6 py-16">
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
