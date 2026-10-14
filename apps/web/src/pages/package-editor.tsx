// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Versioned } from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import type { IntegrationToolCatalogEntry } from "@appstrate/shared-types";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { packageListPath } from "../lib/package-paths";
import type { AgentDefinitionSection } from "../lib/settings-section-href";
import { primaryDisplayFile } from "../lib/package-files";
import { newPackageContent } from "../lib/package-file-drafts";
import { skillFrontmatterError } from "../lib/skill-frontmatter";
import { useEditorState, type EditorState } from "../hooks/use-editor-state";
import { UnsavedChangesModal } from "../components/unsaved-changes-modal";
import { FormField } from "../components/form-field";

// Agent editor components
import { MetadataSection } from "../components/agent-editor/metadata-section";
import { AgentAppearanceFields } from "../components/agent-editor/agent-appearance-fields";
import { SchemaFieldList } from "../components/agent-editor/schema-field-list";
import { ResourceSection } from "../components/agent-editor/resource-section";
import { RuntimeToolsGroup } from "../components/agent-editor/runtime-tools-group";
import { JsonEditor } from "../components/json-editor";
import { PackageFilesEditor } from "../components/package-files/package-files-editor";
import { ManifestEditEntry } from "../components/package-files/package-files-section";
import { SourceSection } from "../components/integration-editor/source-section";
import { getSource, isRemoteSourceUrl } from "../components/integration-editor/utils";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { ToolsPolicySection } from "../components/integration-editor/tools-policy-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import { EditorShell } from "../components/editor-shell";

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
  manifestSchemaWrapper,
  getResourceEntries,
  setResourceEntries,
  getRuntimeTools,
  setRuntimeTools,
  withNormalizedManifest,
  withOutputTool,
  toResourceEntry,
  fieldsToSchema,
} from "../components/agent-editor/utils";
import type { SchemaField } from "../components/agent-editor/types";
import {
  agentSchema,
  skillSchema,
  integrationSchema,
  mcpServerSchema,
} from "@appstrate/core/schemas";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";

const PACKAGE_SCHEMAS: Record<string, object | undefined> = {
  agent: agentSchema,
  skill: skillSchema,
  integration: integrationSchema,
  "mcp-server": mcpServerSchema,
};

type GenericEditorTab =
  | "general"
  | "schema"
  | "skills"
  | "integrations"
  | "source"
  | "auths"
  | "tools"
  | "files"
  | "json";

/**
 * Two presentations of one editor.
 *
 * `page` creates a package: every tab, the files included, on the creation
 * route. `embedded` edits an existing one inside its Paramètres › Package AFPS,
 * one rail section at a time — and there it edits the MANIFEST only. The
 * package's files are changed in Explorer › Fichiers, where the tree is; the
 * Package AFPS › Contenu table only reads them.
 *
 * So the presentation IS the create/edit distinction: `embedded` is what the
 * shared editor pieces call `isEdit`, and only `page` draws a Cancel.
 */
type Presentation = "page" | "embedded";

/**
 * Save from a package's Package AFPS. It saves the draft IN PLACE (no redirect:
 * the reader is already on the package) and reads back the draft's new ETag;
 * the parent refetches the package and remounts the editor on it, which is
 * what clears the unsaved state.
 */
async function saveEmbedded(saveDraft: () => Promise<void>, savedMessage: string) {
  try {
    await saveDraft();
    toast.success(savedMessage);
  } catch {
    // `saveDraft` has already said why, translated, in the editor's error slot.
  }
}

/** The manifest's raw editor, opened from `manifest.json` in Explorer › Fichiers. */
function EmbeddedManifestEntry({
  type,
  manifest,
  onApply,
}: {
  type: PackageType;
  manifest: Record<string, unknown>;
  onApply: (manifest: Record<string, unknown>) => void;
}) {
  return (
    <ManifestEditEntry
      value={manifest}
      schema={{ uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type] ?? {} }}
      onApply={onApply}
    />
  );
}

/** The open section: the settings rail's when it names one (embedded), else the editor's own. */
function useEditorTab(
  tab: GenericEditorTab | undefined,
  onTabRequest: ((tab: GenericEditorTab) => void) | undefined,
) {
  const [localTab, setLocalTab] = useState<GenericEditorTab>("general");
  const setActiveTab = (next: GenericEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);
  return [tab ?? localTab, setActiveTab] as const;
}

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  resolvedDeps,
  packageId,
  effectiveTimeoutSeconds,
  presentation = "page",
  tab,
  onTabRequest,
}: {
  initialState: EditorState;
  resolvedDeps: { skills?: unknown[] } | null;
  packageId: string | undefined;
  /**
   * Timeout this deployment will actually enforce (server-computed: declared
   * value clamped to `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds`). Read off
   * the agent detail the page already loaded — undefined when creating.
   */
  effectiveTimeoutSeconds?: number;
  presentation?: Presentation;
  /** Embedded: the section is the settings rail's, not the editor's. */
  tab?: GenericEditorTab;
  onTabRequest?: (tab: GenericEditorTab) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useEditorTab(tab, onTabRequest);
  const embedded = presentation === "embedded";

  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    setError,
    isDirty,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
    setPreparingFiles,
  } = useEditorState({
    initialState,
    packageType: "agent",
    packageId,
    isEdit: embedded,
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (!embedded && !newPackageContent("agent", s.operations ?? []).trim()) {
        return { error: t("editor.errorPrompt"), tab: "files" };
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
    const wrapper = fieldsToSchema(fields, key, manifestSchemaWrapper(state.manifest, key)?.schema);
    if (wrapper) {
      setState((s) => {
        const manifest = { ...s.manifest, [key]: wrapper };
        return { ...s, manifest: key === "output" ? withOutputTool(manifest) : manifest };
      });
    } else {
      setState((s) => {
        const { [key]: _, ...rest } = s.manifest;
        return { ...s, manifest: rest };
      });
    }
  };

  const discardChanges = () => {
    setState(initialState);
    setSchemaFields(manifestToSchemaFields(initialState.manifest));
    setError(null);
    bumpJsonKey();
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
    embedded
      ? void saveEmbedded(saveDraft, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as GenericEditorTab));

  const setManifestRuntimeTools = (next: string[]) =>
    setState((s) => {
      const m = { ...s.manifest };
      setRuntimeTools(m, next);
      return { ...s, manifest: m };
    });

  const agentTabs: Array<{ id: GenericEditorTab; label: string }> = embedded
    ? [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "schema", label: t("editor.tabSchema") },
        { id: "skills", label: t("editor.tabSkills") },
        { id: "integrations", label: t("editor.tabIntegrations") },
        // The manifest's `runtime_tools`, not integration packages.
        { id: "tools", label: t("editor.tabTools") },
      ]
    : [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "files", label: t("files.tabLabel") },
        { id: "schema", label: t("editor.tabSchema") },
        { id: "skills", label: t("editor.tabSkills") },
        { id: "integrations", label: t("editor.tabIntegrations") },
        { id: "json", label: t("editor.tabJson") },
      ];
  const agentTabDescriptions: Partial<Record<GenericEditorTab, string>> = {
    general: t("editor.description.general"),
    schema: t("editor.description.schema"),
    skills: t("editor.description.skills"),
    integrations: t("editor.description.integrations"),
    tools: t("editor.runtimeToolsHint"),
  };

  return (
    <EditorShell
      type="agent"
      packageId={packageId}
      isEdit={embedded}
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
      onCancel={() => navigate("/")}
      hideSubmitBar={!embedded && activeTab === "json"}
      presentation={presentation}
      activeDescription={embedded ? agentTabDescriptions[activeTab] : undefined}
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={embedded}
          surface={embedded ? "settings" : "card"}
          identityChildren={
            <AgentAppearanceFields manifest={state.manifest} onChange={updateManifest} />
          }
        >
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
              <p className="text-warning text-sm">
                {t("editor.execTimeoutCapped", { seconds: timeoutCeilingSeconds })}
              </p>
            )}
          </div>
        </MetadataSection>
      )}
      {activeTab === "tools" && embedded && (
        <RuntimeToolsGroup
          showHint={false}
          selected={getRuntimeTools(state.manifest)}
          onChange={setManifestRuntimeTools}
        />
      )}
      {activeTab === "schema" && (
        <div className="space-y-6">
          <SchemaFieldList
            title={t("editor.inputTitle")}
            mode="input"
            fields={getSchemaFields("input")}
            onChange={onSchemaChange("input")}
          />
          <SchemaFieldList
            title={t("editor.outputTitle")}
            mode="output"
            fields={getSchemaFields("output")}
            onChange={onSchemaChange("output")}
          />
        </div>
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
          surface={embedded ? "settings" : "card"}
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
            embedded ? undefined : (
              <RuntimeToolsGroup
                selected={getRuntimeTools(state.manifest)}
                onChange={setManifestRuntimeTools}
              />
            )
          }
          surface={embedded ? "settings" : "card"}
        />
      )}
      {embedded && (
        <EmbeddedManifestEntry
          type="agent"
          manifest={state.manifest}
          onApply={(manifest) => {
            setState((s) => ({ ...s, manifest }));
            setSchemaFields(manifestToSchemaFields(manifest));
          }}
        />
      )}
      {activeTab === "json" && !embedded && (
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
      {!embedded && (
        <PackageFilesEditor
          packageId={packageId}
          type="agent"
          active={activeTab === "files"}
          operations={state.operations ?? []}
          onChange={(operations) => setState((current) => ({ ...current, operations }))}
          manifest={state.manifest}
          disabled={isPending}
          onBusyChange={setPreparingFiles}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={embedded ? saveDraft : undefined} />
    </EditorShell>
  );
}

/**
 * An agent's definition, edited where it is read: inside its settings, one
 * rail section at a time, over ONE draft — moving from Schémas to Skills keeps
 * what was typed. Keyed on the draft's ETag, so a save remounts it clean.
 */
export function AgentDefinitionEditor({
  detail,
  section,
  onSection,
}: {
  detail: Versioned<AgentDetail>;
  section: AgentDefinitionSection;
  onSection: (section: AgentDefinitionSection) => void;
}) {
  return (
    <AgentEditorInner
      key={`${detail.id}:${detail.etag}`}
      initialState={{
        manifest: withNormalizedManifest(detail.manifest ?? {}),
        etag: detail.etag,
      }}
      resolvedDeps={detail.dependencies ?? null}
      packageId={detail.id}
      effectiveTimeoutSeconds={detail.effective_timeout_seconds}
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as AgentDefinitionSection)}
    />
  );
}

// ─── Package (Skill/MCP Server) Editor Inner Form ─────────────────────────

function PackageEditorInner({
  type,
  initialState,
  packageId,
  presentation = "page",
}: {
  type: "skill" | "mcp-server";
  initialState: EditorState;
  packageId: string | undefined;
  /** A page to create; embedded in the package's Package AFPS (Identité) to edit. */
  presentation?: Presentation;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");
  const embedded = presentation === "embedded";
  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    setError,
    isDirty,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
    setPreparingFiles,
  } = useEditorState({
    initialState,
    packageType: type,
    packageId,
    isEdit: embedded,
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      if (embedded || type !== "skill") return null;
      const content = newPackageContent(type, s.operations ?? []);
      if (!content.trim()) {
        return { error: t("editor.errorContent"), tab: "files" };
      }
      // The same checker the write routes run — fixed here, not via a 400.
      const frontmatter = skillFrontmatterError(content);
      if (frontmatter) {
        return { error: t(frontmatter.key, frontmatter.params), tab: "files" };
      }
      return null;
    },
  });

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    embedded
      ? void saveEmbedded(saveDraft, t("editor.saved"))
      : handleSubmit(undefined, (tab) => tab && setActiveTab(tab as GenericEditorTab));

  const discardChanges = () => {
    setState(initialState);
    setError(null);
    bumpJsonKey();
  };

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = embedded
    ? [{ id: "general", label: t("editor.tabGeneral") }]
    : [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "files", label: t("files.tabLabel") },
        { id: "json", label: t("editor.tabJson") },
      ];

  return (
    <EditorShell
      type={type}
      packageId={packageId}
      isEdit={embedded}
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
      onCancel={() => navigate(packageListPath(type))}
      hideSubmitBar={!embedded && activeTab === "json"}
      presentation={presentation}
      activeDescription={
        embedded && type === "mcp-server" ? t("mcpServerEditor.description.general") : undefined
      }
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={embedded}
          surface={embedded ? "settings" : "card"}
        />
      )}

      {embedded && (
        <EmbeddedManifestEntry
          type={type}
          manifest={state.manifest}
          onApply={(manifest) => setState((s) => ({ ...s, manifest }))}
        />
      )}

      {activeTab === "json" && !embedded && (
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

      {!embedded && (
        <PackageFilesEditor
          packageId={packageId}
          type={type}
          active={activeTab === "files"}
          operations={state.operations ?? []}
          onChange={(operations) => setState((current) => ({ ...current, operations }))}
          manifest={state.manifest}
          disabled={isPending}
          onBusyChange={setPreparingFiles}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={embedded ? saveDraft : undefined} />
    </EditorShell>
  );
}

// ─── Integration Editor Inner Form ──────────────────────────────────

function IntegrationEditorInner({
  initialState,
  packageId,
  presentation = "page",
  tab,
  onTabRequest,
  toolCatalog,
}: {
  initialState: EditorState;
  packageId: string | undefined;
  /** A page to create; embedded in the integration's Package AFPS to edit. */
  presentation?: Presentation;
  tab?: GenericEditorTab;
  onTabRequest?: (tab: GenericEditorTab) => void;
  /** Embedded: the saved package's tool catalog, shown with the draft's policy. */
  toolCatalog?: IntegrationToolCatalogEntry[];
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useEditorTab(tab, onTabRequest);
  const embedded = presentation === "embedded";

  const {
    state,
    setState,
    updateManifest,
    blocker,
    error,
    setError,
    isDirty,
    jsonEditorKey,
    bumpJsonKey,
    saveDraft,
    handleSubmit,
    isPending,
    setPreparingFiles,
  } = useEditorState({
    initialState,
    packageType: "integration",
    packageId,
    isEdit: embedded,
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      const source = getSource(s.manifest);
      if (source.kind === "remote" && !isRemoteSourceUrl(source.remoteUrl)) {
        return { error: t("integrationEditor.source.errorRemoteUrl"), tab: "source" };
      }
      return null;
    },
  });

  const discardChanges = () => {
    setState(initialState);
    setError(null);
    bumpJsonKey();
  };

  const sectionSurface = embedded ? "settings" : "card";
  const integrationTabDescriptions: Partial<Record<GenericEditorTab, string>> = {
    general: t("integrationEditor.description.general"),
    source: t("integrationEditor.description.source"),
    auths: t("integrationEditor.description.auths"),
    tools: t("integrationEditor.description.tools"),
  };

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    embedded
      ? void saveEmbedded(saveDraft, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as GenericEditorTab));

  const onManifestChange = (manifest: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest }));

  // Embedded, the labels are the settings rail's, so heading and rail agree.
  const integrationTabs: Array<{ id: GenericEditorTab; label: string }> = embedded
    ? [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "source", label: t("integrationEditor.tabSource") },
        { id: "auths", label: t("integrationEditor.tabAuthMethods") },
        { id: "tools", label: t("integrationEditor.tabTools") },
      ]
    : [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "source", label: t("integrationEditor.tabSource") },
        { id: "auths", label: t("integrationEditor.tabAuths") },
        { id: "tools", label: t("integrationEditor.tabTools") },
        { id: "files", label: t("files.tabLabel") },
        { id: "json", label: t("editor.tabJson") },
      ];

  return (
    <EditorShell
      type="integration"
      packageId={packageId}
      isEdit={embedded}
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
      onCancel={() => navigate(packageListPath("integration"))}
      hideSubmitBar={!embedded && activeTab === "json"}
      presentation={presentation}
      activeDescription={embedded ? integrationTabDescriptions[activeTab] : undefined}
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={embedded}
          surface={sectionSurface}
        />
      )}

      {activeTab === "source" && (
        <SourceSection
          manifest={state.manifest}
          onChange={onManifestChange}
          surface={sectionSurface}
        />
      )}

      {activeTab === "auths" && (
        <AuthsSection
          manifest={state.manifest}
          onChange={onManifestChange}
          surface={sectionSurface}
        />
      )}

      {activeTab === "tools" &&
        (toolCatalog ? (
          <IntegrationToolsSection
            tools={toolCatalog}
            edit={{ manifest: state.manifest, onChange: onManifestChange }}
          />
        ) : (
          <ToolsPolicySection
            manifest={state.manifest}
            onChange={onManifestChange}
            surface={sectionSurface}
          />
        ))}

      {embedded && (
        <EmbeddedManifestEntry
          type="integration"
          manifest={state.manifest}
          onApply={(manifest) => setState((s) => ({ ...s, manifest }))}
        />
      )}
      {activeTab === "json" && !embedded && (
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

      {!embedded && (
        <PackageFilesEditor
          packageId={packageId}
          type="integration"
          active={activeTab === "files"}
          operations={state.operations ?? []}
          onChange={(operations) => setState((current) => ({ ...current, operations }))}
          manifest={state.manifest}
          disabled={isPending}
          onBusyChange={setPreparingFiles}
        />
      )}

      <UnsavedChangesModal blocker={blocker} onSaveDraft={embedded ? saveDraft : undefined} />
    </EditorShell>
  );
}

export type IntegrationDefinitionSection = "general" | "source" | "auths" | "tools";

/** An integration's definition, edited inside its settings — see `AgentDefinitionEditor`. */
export function IntegrationDefinitionEditor({
  detail,
  section,
  onSection,
  toolCatalog,
}: {
  detail: Versioned<OrgPackageItemDetail>;
  section: IntegrationDefinitionSection;
  onSection: (section: IntegrationDefinitionSection) => void;
  toolCatalog: IntegrationToolCatalogEntry[];
}) {
  return (
    <IntegrationEditorInner
      key={`${detail.id}:${detail.etag}`}
      initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
      packageId={detail.id}
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as IntegrationDefinitionSection)}
      toolCatalog={toolCatalog}
    />
  );
}

/**
 * A skill's or a local MCP server's definition, edited inside its settings.
 * Identité is the one form: a skill's SKILL.md and references, a server's code,
 * are files, and change in Explorer › Fichiers. `server`, `tools` and
 * `user_config` of a server are authored in the raw manifest, reached from
 * under the form like every other package's.
 */
export function PackageDefinitionEditor({
  type,
  detail,
}: {
  type: "skill" | "mcp-server";
  detail: Versioned<OrgPackageItemDetail>;
}) {
  return (
    <PackageEditorInner
      key={`${detail.id}:${detail.etag}`}
      type={type}
      initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
      packageId={detail.id}
      presentation="embedded"
    />
  );
}

// ─── Page Wrapper ───────────────────────────────────────────────────

/** The creation route of a package type: an existing package is edited in its settings. */
export function PackageEditorPage({ type }: { type: "agent" | "skill" | "integration" }) {
  const { user } = useAuth();
  const { currentOrg } = useOrg();

  if (type === "agent") {
    return (
      <AgentEditorInner
        initialState={defaultEditorState(currentOrg?.slug, user?.email)}
        resolvedDeps={null}
        packageId={undefined}
      />
    );
  }

  if (type === "integration") {
    return (
      <IntegrationEditorInner
        initialState={{ manifest: defaultIntegrationManifest(currentOrg?.slug, user?.email) }}
        packageId={undefined}
      />
    );
  }

  return (
    <PackageEditorInner
      type={type}
      initialState={{
        manifest: defaultSkillManifest(currentOrg?.slug, user?.email),
        operations: [
          { op: "write", path: primaryDisplayFile(type).name, text: DEFAULT_SKILL_CONTENT },
        ],
      }}
      packageId={undefined}
    />
  );
}
