// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePackageDetail } from "../hooks/use-packages";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";
import { primaryDisplayFile } from "../lib/package-files";
import { skillFrontmatterError, translateSkillFrontmatterError } from "../lib/skill-frontmatter";
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
import {
  PackageFilesEditor,
  type PackageFilesEditorHandle,
} from "../components/package-files/package-files-editor";
import { hasDraftTexts, type DraftTexts } from "../lib/package-file-drafts";
import { packageFilesErrorKey } from "../lib/package-files";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { formatBytes } from "@appstrate/core/format";
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
  withNormalizedManifest,
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
  | "files"
  | "json";

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  resolvedDeps,
  packageId,
  isEdit,
  effectiveTimeoutSeconds,
}: {
  initialState: AgentEditorState;
  resolvedDeps: { skills?: unknown[] } | null;
  packageId: string | undefined;
  isEdit: boolean;
  /**
   * Timeout this deployment will actually enforce (server-computed: declared
   * value clamped to `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds`). Read off
   * the agent detail the page already loaded — undefined when creating.
   */
  effectiveTimeoutSeconds?: number;
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

  // Deployment run-timeout ceiling, surfaced as a non-blocking hint under the
  // timeout field. The server sends only `effective_timeout_seconds`
  // (= min(declared, ceiling)), which pins the ceiling EXACTLY when it clamped
  // the saved declaration. When it did not clamp, the ceiling is only known to
  // be >= that value, so we stay silent rather than warn about a number we
  // cannot judge. `undefined` here = no hint.
  const savedTimeout =
    typeof initialState.manifest.timeout === "number" ? initialState.manifest.timeout : undefined;
  const declaredTimeout =
    typeof state.manifest.timeout === "number" ? state.manifest.timeout : undefined;
  const knownCeiling =
    effectiveTimeoutSeconds !== undefined &&
    savedTimeout !== undefined &&
    effectiveTimeoutSeconds < savedTimeout
      ? effectiveTimeoutSeconds
      : undefined;
  const timeoutCeilingSeconds =
    knownCeiling !== undefined && declaredTimeout !== undefined && declaredTimeout > knownCeiling
      ? knownCeiling
      : undefined;

  // Schema fields are stored in local state to preserve fields being edited (empty key).
  // Only complete fields are persisted to the manifest via fieldsToSchema.
  const [schemaFields, setSchemaFields] = useState<Record<string, SchemaField[]>>(() =>
    manifestToSchemaFields(state.manifest),
  );

  const getSchemaFields = (key: "input" | "output") => schemaFields[key] ?? [];

  const onSchemaChange = (key: "input" | "output") => (fields: SchemaField[]) => {
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

  // Sync resolved skill metadata from server (names, descriptions). The group
  // is absent from a summary read of the agent, and then there is nothing to
  // sync — the editor keeps what the manifest declares.
  const resolvedSkills = resolvedDeps?.skills;
  useEffect(() => {
    if (!resolvedSkills) return;
    setState((prev) => {
      const m = { ...prev.manifest };
      const skills = (
        resolvedSkills as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry);
      setResourceEntries(m, "skills", skills);
      return { ...prev, manifest: m };
    });
  }, [resolvedSkills, setState]);

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
          <div className="space-y-2">
            <FormField
              id="meta-timeout"
              label={t("editor.execTimeout")}
              type="number"
              min={1}
              value={
                typeof state.manifest.timeout === "number" ? String(state.manifest.timeout) : ""
              }
              onChange={(v) => {
                const n = parseInt(v, 10);
                // `undefined` clears the key through the shallow manifest merge
                // (JSON serialization drops it on save → server default, 300s).
                updateManifest({ timeout: Number.isNaN(n) ? undefined : n });
              }}
              placeholder="300"
              description={t("editor.execTimeoutDesc")}
            />
            {/* Non-blocking: the ceiling is deployment-specific, so a manifest
                declaring above it stays valid (and portable to a deployment
                with a higher ceiling). We only tell the author what this
                deployment will actually enforce — never clamp the input. */}
            {timeoutCeilingSeconds !== undefined && (
              <p className="text-sm text-amber-400">
                {t("editor.execTimeoutCapped", { seconds: timeoutCeilingSeconds })}
              </p>
            )}
          </div>
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
  const contentTab: GenericEditorTab = isEdit ? "files" : "content";
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");
  // Buffered file edits live here, beside the manifest, because the two
  // together are what "unsaved changes" means for this editor. The files editor
  // below owns the route that sends them.
  const [drafts, setDrafts] = useState<DraftTexts>({});
  const filesRef = useRef<PackageFilesEditorHandle>(null);

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
    extraDirty: hasDraftTexts(drafts),
    // Buffered file edits go first, as one atomic batch, and hand the manifest
    // save the token they left on the row. A save with nothing buffered writes
    // no files and keeps the token the editor already holds.
    beforeUpdate: useCallback(async () => filesRef.current?.flush(), []),
    // On an existing skill `SKILL.md` is a file like any other, authored
    // through `PATCH .../files`; the manifest save carries the stored draft
    // forward. On create there is no package to patch yet, so the single
    // Monaco below IS the content and the create route requires it.
    toWireBody: (s) =>
      isEdit ? { manifest: s.manifest } : { manifest: s.manifest, content: s.content },
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      // While editing, the authoritative copy of the content entry is whatever
      // the files editor holds — its buffer if the author typed, else the
      // index. `undefined` means the index has not landed: the server runs the
      // same checker on the bytes it stores, so there is nothing to add here.
      const content = isEdit ? filesRef.current?.contentEntryText() : s.content;
      if (content === undefined) return null;
      if (!content.trim()) {
        return { error: t("editor.errorContent"), tab: contentTab };
      }
      // The same checker the write routes run — fixed here, not via a 400.
      const frontmatter = skillFrontmatterError(content);
      if (frontmatter) {
        return { error: t(frontmatter.key, { detail: frontmatter.detail }), tab: contentTab };
      }
      return null;
    },
    // One save sends two requests, so the banner asks both translators: the
    // file batch goes first and can be refused on its own terms (a `412` from a
    // second tab, above all), and only what it does not own falls through to
    // the manifest's frontmatter messages.
    translateError: (err) => {
      const fileRefusal = packageFilesErrorKey(err);
      return fileRefusal
        ? t(fileRefusal, { limit: formatBytes(PACKAGE_FILE_INLINE_MAX_BYTES) })
        : translateSkillFrontmatterError(err, t);
    },
  });

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: contentTab, label: isEdit ? t("files.tabLabel") : primaryDisplayFile(type).name },
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

      {/* No `key`: `state.content` has exactly one writer, the editor's own
          `onChange` — the JSON tab applies the manifest and nothing else — so
          there is never a text to push back into a mounted Monaco. */}
      {activeTab === "content" && (
        <ContentEditor
          value={state.content}
          onChange={(content) => setState((s) => ({ ...s, content }))}
          language="markdown"
        />
      )}

      {/* Mounted on every tab, rendering only on its own: the buffered edits it
          sends and the ETag it writes with must survive a trip to the General
          tab, and the save bar reaches it from anywhere. */}
      {isEdit && (
        <PackageFilesEditor
          ref={filesRef}
          packageId={packageId!}
          type={type}
          active={activeTab === "files"}
          drafts={drafts}
          setDrafts={setDrafts}
          onLockVersion={(lock_version) => setState((s) => ({ ...s, lock_version }))}
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

export function PackageEditorPage({ type }: { type: Exclude<PackageType, "mcp-server"> }) {
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
            manifest: withNormalizedManifest(agentDetail.manifest ?? {}),
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
        effectiveTimeoutSeconds={agentDetail?.effective_timeout_seconds}
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

  // `content` is the CREATE form's single Monaco buffer and nothing else: an
  // existing skill authors `SKILL.md` through the files editor, which reads it
  // from the file index. Seeding it here would leave a second copy of the file
  // in editor state, free to go stale behind every save.
  const initialState: PackageEditorState =
    isEdit && pkgDetail
      ? {
          manifest: pkgDetail.manifest ?? {},
          content: "",
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
