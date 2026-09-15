// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import { usePackageDetail } from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import type { PackageType } from "@appstrate/core/validation";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";
import { primaryDisplayFile } from "../lib/package-files";
import { integrationDocument, integrationWireContent } from "../lib/integration-document";
import { skillFrontmatterError, translateSkillFrontmatterError } from "../lib/skill-frontmatter";
import { useEditorState, type EditorStateBase } from "../hooks/use-editor-state";
import { useUnsavedChanges } from "../hooks/use-unsaved-changes";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { invalidatePackageFiles, packageKeys } from "../lib/query-keys";
import { UnsavedChangesModal } from "../components/unsaved-changes-modal";
import { FormField } from "../components/form-field";

// Agent editor components
import { MetadataSection } from "../components/agent-editor/metadata-section";
import { AgentAppearanceFields } from "../components/agent-editor/agent-appearance-fields";
import { SchemaSection } from "../components/agent-editor/schema-section";
import { ResourceSection } from "../components/agent-editor/resource-section";
import { RuntimeToolsGroup } from "../components/agent-editor/runtime-tools-group";
import { PromptEditor } from "../components/agent-editor/prompt-editor";
import { JsonEditor } from "../components/json-editor";
import { ContentEditor } from "../components/package-editor/content-editor";
import { SourceSection } from "../components/integration-editor/source-section";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { ToolsPolicySection } from "../components/integration-editor/tools-policy-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import type { IntegrationToolInspection } from "@appstrate/core/integration";
import { Spinner } from "../components/spinner";
import { EditorShell } from "../components/editor-shell";
import {
  ManifestEditEntry,
  PackageFilesSection,
} from "../components/package-files/package-files-section";

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

/**
 * Save from a package's Définition. It saves the draft IN PLACE (no redirect:
 * the reader is already on the package) and reads back the new lock version;
 * the parent refetches the package and remounts the editor on it, which is
 * what clears the unsaved state.
 */
async function saveEmbedded(
  saveDraft: () => Promise<void>,
  setError: (message: string | null) => void,
  savedMessage: string,
) {
  try {
    await saveDraft();
    toast.success(savedMessage);
  } catch (err) {
    // `saveDraft` has already shown a validation error; surface the rest.
    setError(getErrorMessage(err));
  }
}

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  resolvedDeps,
  packageId,
  isEdit,
  effectiveTimeoutSeconds,
  presentation = "page",
  onCancel,
  initialTab = "general",
  tab,
  onTabRequest,
  filesHref,
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
  presentation?: "page" | "panel-dialog" | "embedded";
  onCancel?: () => void;
  initialTab?: GenericEditorTab;
  /** Embedded: the section is the settings rail's, not the editor's. */
  tab?: GenericEditorTab;
  onTabRequest?: (tab: GenericEditorTab) => void;
  /** Embedded: Explorer › Fichiers, opened on a file. */
  filesHref?: (path: string) => string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [localTab, setLocalTab] = useState<GenericEditorTab>(initialTab);
  const activeTab = tab ?? localTab;
  const setActiveTab = (next: GenericEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);

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
    onSuccess: presentation === "panel-dialog" ? onCancel : undefined,
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

  const discardChanges = () => {
    setState(initialState);
    setSchemaFields(manifestToSchemaFields(initialState.manifest));
    setError(null);
    bumpJsonKey();
  };

  // Sync resolved skill metadata from server (names, descriptions)
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
    presentation === "embedded"
      ? void saveEmbedded(saveDraft, setError, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as GenericEditorTab));

  const agentTabs: Array<{ id: GenericEditorTab; label: string }> = [
    {
      id: "general",
      label: presentation === "page" ? t("editor.tabGeneral") : t("editor.tabIdentity"),
    },
    // Embedded, the prompt is a file of the package, edited from its table.
    ...(presentation === "embedded"
      ? []
      : [
          {
            id: "prompt" as const,
            label:
              presentation === "page" ? primaryDisplayFile("agent").name : t("editor.tabPrompt"),
          },
        ]),
    { id: "schema", label: t("editor.tabSchema") },
    { id: "skills", label: t("editor.tabSkills") },
    { id: "integrations", label: t("editor.tabIntegrations") },
    // Embedded, the runtime tools are their own section of the package: they
    // are the manifest's `runtime_tools`, not integration packages.
    ...(presentation === "embedded"
      ? [
          { id: "tools" as const, label: t("editor.tabTools") },
          { id: "files" as const, label: t("editor.tabPackageFiles") },
        ]
      : []),
    { id: "json", label: t("editor.tabJson") },
  ];
  const agentTabDescriptions: Partial<Record<GenericEditorTab, string>> = {
    general: t("editor.description.general"),
    prompt: t("editor.description.prompt"),
    schema: t("editor.description.schema"),
    skills: t("editor.description.skills"),
    integrations: t("editor.description.integrations"),
    tools: t("editor.runtimeToolsHint"),
    files: t("editor.description.packageFiles"),
    json: t("editor.description.json"),
  };

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
      onCancel={onCancel ?? (() => navigate(isEdit ? `/agents/${packageId}` : "/"))}
      hideSubmitBar={presentation === "page" && activeTab === "json"}
      presentation={presentation}
      panelTitle={presentation === "page" ? undefined : t("editor.editBundle")}
      activeDescription={presentation === "page" ? undefined : agentTabDescriptions[activeTab]}
      activeSecondaryDescription={
        presentation !== "page" && activeTab === "prompt" ? t("editor.promptHint") : undefined
      }
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={isEdit}
          surface={presentation === "page" ? "card" : "settings"}
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
              <p className="text-sm text-amber-400">
                {t("editor.execTimeoutCapped", { seconds: timeoutCeilingSeconds })}
              </p>
            )}
          </div>
        </MetadataSection>
      )}
      {activeTab === "prompt" && presentation !== "embedded" && (
        <PromptEditor
          value={state.prompt}
          onChange={(prompt) => setState((s) => ({ ...s, prompt }))}
          showHint={presentation === "page"}
        />
      )}
      {activeTab === "tools" && presentation === "embedded" && (
        <RuntimeToolsGroup
          showHint={false}
          selected={getRuntimeTools(state.manifest)}
          onChange={(next) => {
            setState((s) => {
              const m = { ...s.manifest };
              setRuntimeTools(m, next);
              return { ...s, manifest: m };
            });
          }}
        />
      )}
      {activeTab === "files" && presentation === "embedded" && packageId && filesHref && (
        <PackageFilesSection
          type="agent"
          packageId={packageId}
          manifest={state.manifest}
          documents={{
            [primaryDisplayFile("agent").name]: {
              value: state.prompt,
              onApply: (prompt) => setState((s) => ({ ...s, prompt })),
            },
          }}
          filesHref={filesHref}
        />
      )}
      {activeTab === "schema" && (
        <>
          <SchemaSection
            title={t("editor.inputTitle")}
            mode="input"
            fields={getSchemaFields("input")}
            onChange={onSchemaChange("input")}
            surface={presentation === "page" ? "card" : "settings"}
          />
          <SchemaSection
            title={t("editor.outputTitle")}
            mode="output"
            fields={getSchemaFields("output")}
            onChange={onSchemaChange("output")}
            surface={presentation === "page" ? "card" : "settings"}
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
          surface={presentation === "page" ? "card" : "settings"}
        />
      )}
      {activeTab === "integrations" && (
        <div className={presentation === "page" ? undefined : "space-y-8"}>
          {presentation === "panel-dialog" && (
            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold">{t("editor.tabRuntimeTools")}</h3>
              </div>
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
            </section>
          )}
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
              presentation === "page" ? (
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
              ) : undefined
            }
            surface={presentation === "page" ? "card" : "settings"}
          />
        </div>
      )}
      {presentation === "embedded" && (
        <ManifestEditEntry
          value={state.manifest}
          schema={{ uri: AFPS_SCHEMA_URLS.agent, schema: PACKAGE_SCHEMAS.agent! }}
          showLink={activeTab !== "files"}
          onApply={(manifest) => {
            setState((s) => ({ ...s, manifest }));
            setSchemaFields(manifestToSchemaFields(manifest));
          }}
        />
      )}
      {activeTab === "json" && presentation !== "embedded" && (
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

export type AgentDefinitionSection =
  "general" | "schema" | "skills" | "integrations" | "tools" | "files" | "json";

/**
 * An agent's definition, edited where it is read: inside its settings, one
 * rail section at a time, over ONE draft — moving from Prompt to Schéma keeps
 * what was typed. Keyed on the lock version, so a save remounts it clean.
 */
export function AgentDefinitionEditor({
  detail,
  section,
  onSection,
  filesHref,
}: {
  detail: AgentDetail;
  section: AgentDefinitionSection;
  onSection: (section: AgentDefinitionSection) => void;
  filesHref: (path: string) => string;
}) {
  return (
    <AgentEditorInner
      key={`${detail.id}:${detail.lock_version}`}
      initialState={{
        manifest: withNormalizedManifest(detail.manifest ?? {}),
        prompt: detail.prompt || "",
        lock_version: detail.lock_version,
      }}
      resolvedDeps={detail.dependencies ?? null}
      packageId={detail.id}
      isEdit
      effectiveTimeoutSeconds={detail.effective_timeout_seconds}
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as AgentDefinitionSection)}
      filesHref={filesHref}
    />
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
  presentation = "page",
  tab,
  onTabRequest,
  filesHref,
}: {
  type: "skill";
  initialState: PackageEditorState;
  packageId: string | undefined;
  isEdit: boolean;
  /** A page to create; embedded in the skill's Définition to edit. */
  presentation?: "page" | "embedded";
  tab?: GenericEditorTab;
  onTabRequest?: (tab: GenericEditorTab) => void;
  /** Where the bundle's other files are read: Explorer › Fichiers, on that file. */
  filesHref?: (path: string) => string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [localTab, setLocalTab] = useState<GenericEditorTab>("general");
  const activeTab = tab ?? localTab;
  const setActiveTab = (next: GenericEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);

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
      // The same checker the write routes run — fixed here, not via a 400.
      const frontmatter = skillFrontmatterError(s.content);
      if (frontmatter) {
        return { error: t(frontmatter.key, { detail: frontmatter.detail }), tab: "content" };
      }
      return null;
    },
    translateError: (err) => translateSkillFrontmatterError(err, t),
  });

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    presentation === "embedded"
      ? void saveEmbedded(saveDraft, setError, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as GenericEditorTab));

  const discardChanges = () => {
    setState(initialState);
    setError(null);
    bumpJsonKey();
  };

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    {
      id: "general",
      label: presentation === "page" ? t("editor.tabGeneral") : t("editor.tabIdentity"),
    },
    ...(presentation === "embedded"
      ? [{ id: "files" as const, label: t("editor.tabPackageFiles") }]
      : [{ id: "content" as const, label: primaryDisplayFile(type).name }]),
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
      hideSubmitBar={presentation === "page" && activeTab === "json"}
      presentation={presentation}
      activeDescription={
        presentation === "embedded" && activeTab === "files"
          ? t("editor.description.packageFiles")
          : undefined
      }
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={isEdit}
          surface={presentation === "page" ? "card" : "settings"}
        />
      )}

      {activeTab === "content" && presentation !== "embedded" && (
        <ContentEditor
          value={state.content}
          onChange={(content) => setState((s) => ({ ...s, content }))}
          language="markdown"
        />
      )}
      {activeTab === "files" && presentation === "embedded" && packageId && filesHref && (
        <PackageFilesSection
          type={type}
          packageId={packageId}
          manifest={state.manifest}
          documents={{
            [primaryDisplayFile(type).name]: {
              value: state.content,
              onApply: (content) => setState((s) => ({ ...s, content })),
            },
          }}
          filesHref={filesHref}
        />
      )}

      {presentation === "embedded" && (
        <ManifestEditEntry
          value={state.manifest}
          schema={{ uri: AFPS_SCHEMA_URLS[type], schema: PACKAGE_SCHEMAS[type]! }}
          showLink={activeTab !== "files"}
          onApply={(manifest) => setState((s) => ({ ...s, manifest }))}
        />
      )}

      {activeTab === "json" && presentation === "page" && (
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
  presentation = "page",
  onCancel,
  tab,
  onTabRequest,
  filesHref,
  toolInspection,
}: {
  initialState: PackageEditorState;
  packageId: string | undefined;
  isEdit: boolean;
  /** A page to create; embedded in the integration's Package AFPS to edit. */
  presentation?: "page" | "embedded";
  onCancel?: () => void;
  tab?: GenericEditorTab;
  onTabRequest?: (tab: GenericEditorTab) => void;
  /** Embedded: Explorer › Fichiers, opened on a file. */
  filesHref?: (path: string) => string;
  /** Embedded: the server's reading of the saved tool catalog. */
  toolInspection?: IntegrationToolInspection;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const [localTab, setLocalTab] = useState<GenericEditorTab>("general");
  const activeTab = tab ?? localTab;
  const setActiveTab = (next: GenericEditorTab) =>
    tab !== undefined ? onTabRequest?.(next) : setLocalTab(next);

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
  } = useEditorState<PackageEditorState>({
    initialState,
    packageType: "integration",
    packageId,
    isEdit,
    // `content` is the optional INTEGRATION.md; without one it is the manifest
    // text, which the API refreshes its fallback from. Either way the API
    // rebuilds `manifest.json` from the manifest itself.
    toWireBody: (s) => ({
      manifest: s.manifest,
      content: integrationWireContent(s.manifest, s.content),
    }),
    validate: (s) => {
      const { id } = getManifestName(s.manifest);
      if (!id) {
        return { error: t("editor.errorRequired"), tab: "general" };
      }
      return null;
    },
  });

  const discardChanges = () => {
    setState(initialState);
    setError(null);
    bumpJsonKey();
  };

  const sectionSurface = presentation === "page" ? "card" : "settings";
  const integrationTabDescriptions: Partial<Record<GenericEditorTab, string>> = {
    general: t("integrationEditor.description.general"),
    source: t("integrationEditor.description.source"),
    auths: t("integrationEditor.description.auths"),
    tools: t("integrationEditor.description.tools"),
    content: t("integrationEditor.description.content"),
    files: t("editor.description.packageFiles"),
    json: t("editor.description.json"),
  };

  const metadata = useMemo(() => manifestToMetadata(state.manifest), [state.manifest]);
  const onMetadataChange = (m: MetadataState) => updateManifest(metadataToManifestPatch(m));

  const onSubmit = () =>
    presentation === "embedded"
      ? void saveEmbedded(saveDraft, setError, t("editor.saved"))
      : handleSubmit(undefined, (next) => next && setActiveTab(next as GenericEditorTab));

  const onManifestChange = (manifest: Record<string, unknown>) =>
    setState((s) => ({ ...s, manifest }));

  // Embedded, the labels are the settings rail's, so heading and rail agree.
  const integrationTabs: Array<{ id: GenericEditorTab; label: string }> = [
    {
      id: "general",
      label: presentation === "page" ? t("editor.tabGeneral") : t("editor.tabIdentity"),
    },
    { id: "source", label: t("integrationEditor.tabSource") },
    {
      id: "auths",
      label:
        presentation === "page"
          ? t("integrationEditor.tabAuths")
          : t("integrationEditor.tabAuthMethods"),
    },
    {
      id: "tools",
      label: t("integrationEditor.tabTools"),
    },
    presentation === "embedded"
      ? { id: "files", label: t("editor.tabPackageFiles") }
      : { id: "content", label: INTEGRATION_DOCUMENT },
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
      onCancel={
        onCancel ??
        (() =>
          navigate(
            isEdit ? packageDetailPath("integration", packageId!) : packageListPath("integration"),
          ))
      }
      hideSubmitBar={presentation === "page" && activeTab === "json"}
      presentation={presentation}
      activeDescription={
        presentation === "page" ? undefined : integrationTabDescriptions[activeTab]
      }
      isDirty={isDirty}
      onDiscardChanges={discardChanges}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={metadata}
          onChange={onMetadataChange}
          isEdit={isEdit}
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
        (presentation === "embedded" ? (
          <IntegrationToolsSection
            inspection={toolInspection}
            edit={{ manifest: state.manifest, onChange: onManifestChange }}
          />
        ) : (
          <ToolsPolicySection
            manifest={state.manifest}
            onChange={onManifestChange}
            surface={sectionSurface}
          />
        ))}

      {activeTab === "content" && presentation !== "embedded" && (
        <ContentEditor
          value={state.content}
          onChange={(content) => setState((s) => ({ ...s, content }))}
          language="markdown"
        />
      )}
      {activeTab === "files" && presentation === "embedded" && packageId && filesHref && (
        <PackageFilesSection
          type="integration"
          packageId={packageId}
          manifest={state.manifest}
          documents={{
            [INTEGRATION_DOCUMENT]: {
              value: state.content,
              onApply: (content) => setState((s) => ({ ...s, content })),
            },
          }}
          filesHref={filesHref}
        />
      )}

      {presentation === "embedded" && (
        <ManifestEditEntry
          value={state.manifest}
          schema={{ uri: AFPS_SCHEMA_URLS.integration, schema: PACKAGE_SCHEMAS.integration! }}
          showLink={activeTab !== "files"}
          onApply={(manifest) => setState((s) => ({ ...s, manifest }))}
        />
      )}
      {activeTab === "json" && presentation !== "embedded" && (
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

export type IntegrationDefinitionSection =
  "general" | "source" | "auths" | "tools" | "files" | "json";

/** An integration's optional companion document, named as the bundle names it. */
const INTEGRATION_DOCUMENT = "INTEGRATION.md";

/** An integration's definition, edited inside its settings — see `AgentDefinitionEditor`. */
export function IntegrationDefinitionEditor({
  detail,
  section,
  onSection,
  filesHref,
  toolInspection,
}: {
  detail: OrgPackageItemDetail;
  section: IntegrationDefinitionSection;
  onSection: (section: IntegrationDefinitionSection) => void;
  filesHref: (path: string) => string;
  toolInspection?: IntegrationToolInspection;
}) {
  return (
    <IntegrationEditorInner
      key={`${detail.id}:${detail.lock_version}`}
      initialState={{
        manifest: detail.manifest ?? {},
        content: integrationDocument(detail.content),
        lock_version: detail.lock_version,
      }}
      packageId={detail.id}
      isEdit
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as IntegrationDefinitionSection)}
      filesHref={filesHref}
      toolInspection={toolInspection}
    />
  );
}

export type SkillDefinitionSection = "general" | "files";

/** A skill's definition, edited inside its settings — see `AgentDefinitionEditor`. */
export function SkillDefinitionEditor({
  detail,
  section,
  onSection,
  filesHref,
}: {
  detail: OrgPackageItemDetail;
  section: SkillDefinitionSection;
  onSection: (section: SkillDefinitionSection) => void;
  filesHref: (path: string) => string;
}) {
  return (
    <PackageEditorInner
      key={`${detail.id}:${detail.lock_version}`}
      type="skill"
      initialState={{
        manifest: detail.manifest ?? {},
        content: detail.content ?? "",
        lock_version: detail.lock_version,
      }}
      packageId={detail.id}
      isEdit
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as SkillDefinitionSection)}
      filesHref={filesHref}
    />
  );
}

/**
 * A local MCP server's definition. The server has no content file and no form
 * of its own beyond its identity — `server`, `tools` and `user_config` are
 * authored in the manifest — so its Définition is Identité, with the manifest
 * reached raw like every other package. Update-only: a server is never
 * created here (it arrives by import), which is why this does not go through
 * `useEditorState`, whose create path the type has not got.
 */
export type McpServerDefinitionSection = "general" | "files";

interface McpServerDefinitionProps {
  detail: OrgPackageItemDetail;
  section: McpServerDefinitionSection;
  filesHref: (path: string) => string;
}

export function McpServerDefinitionEditor(props: McpServerDefinitionProps) {
  return (
    <McpServerDefinitionInner key={`${props.detail.id}:${props.detail.lock_version}`} {...props} />
  );
}

function McpServerDefinitionInner({ detail, section, filesHref }: McpServerDefinitionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const initial = detail.manifest ?? {};
  const [manifest, setManifest] = useState<Record<string, unknown>>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isDirty = JSON.stringify(manifest) !== JSON.stringify(initial);
  const { blocker, allowNavigation } = useUnsavedChanges(isDirty);
  const metadata = useMemo(() => manifestToMetadata(manifest), [manifest]);

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await client.PUT("/api/packages/mcp-servers/{scope}/{name}", {
        params: { path: splitPackageRef(detail.id) },
        body: {
          manifest,
          content: JSON.stringify(manifest, null, 2),
          lock_version: detail.lock_version ?? 0,
        } as never,
      });
      allowNavigation();
      toast.success(t("editor.saved"));
      await qc.invalidateQueries({ queryKey: packageKeys.all });
      invalidatePackageFiles(qc);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <EditorShell
      type="mcp-server"
      packageId={detail.id}
      isEdit
      displayName={(manifest.display_name as string) || detail.id}
      tabs={[
        { id: "general", label: t("editor.tabIdentity") },
        { id: "files", label: t("editor.tabPackageFiles") },
      ]}
      activeTab={section}
      onTabChange={() => {}}
      error={error}
      isPending={pending}
      onSubmit={() => void save()}
      onCancel={() => {}}
      presentation="embedded"
      activeDescription={t(
        section === "files"
          ? "editor.description.packageFiles"
          : "mcpServerEditor.description.general",
      )}
      isDirty={isDirty}
      onDiscardChanges={() => {
        setManifest(initial);
        setError(null);
      }}
    >
      {section === "general" ? (
        <MetadataSection
          value={metadata}
          onChange={(m) => setManifest((prev) => ({ ...prev, ...metadataToManifestPatch(m) }))}
          isEdit
          surface="settings"
        />
      ) : (
        <PackageFilesSection
          type="mcp-server"
          packageId={detail.id}
          manifest={manifest}
          documents={{}}
          filesHref={filesHref}
        />
      )}
      <ManifestEditEntry
        value={manifest}
        schema={{
          uri: AFPS_SCHEMA_URLS["mcp-server"],
          schema: PACKAGE_SCHEMAS["mcp-server"] ?? {},
        }}
        showLink={section === "general"}
        onApply={setManifest}
      />
      <UnsavedChangesModal blocker={blocker} />
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
    const initialState: PackageEditorState =
      isEdit && intDetail
        ? {
            manifest: intDetail.manifest ?? {},
            content: integrationDocument(intDetail.content),
            lock_version: intDetail.lock_version,
          }
        : { manifest: defaultIntegrationManifest(currentOrg?.slug, user?.email), content: "" };

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
