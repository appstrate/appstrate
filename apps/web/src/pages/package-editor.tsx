// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Versioned } from "../hooks/use-packages";
import type { AgentDetail, OrgPackageItemDetail } from "@appstrate/shared-types";
import type { IntegrationToolInspection } from "@appstrate/core/integration";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import type { AgentDefinitionSection } from "../lib/settings-section-href";
import { primaryDisplayFile } from "../lib/package-files";
import { newPackageContent } from "../lib/package-file-drafts";
import { skillFrontmatterError } from "../lib/skill-frontmatter";
import type { EditorState } from "../hooks/use-editor-state";
import { FormField } from "../components/form-field";
import {
  usePackageEditor,
  type PackageEditorTab,
  type Presentation,
} from "../components/package-editor/use-package-editor";
import { PackageEditorFrame } from "../components/package-editor/package-editor-frame";

// Agent editor components
import { MetadataSection } from "../components/agent-editor/metadata-section";
import { AgentAppearanceFields } from "../components/agent-editor/agent-appearance-fields";
import { SchemaFieldList } from "../components/agent-editor/schema-field-list";
import { ResourceSection } from "../components/agent-editor/resource-section";
import { RuntimeToolsGroup } from "../components/agent-editor/runtime-tools-group";
import { SourceSection } from "../components/integration-editor/source-section";
import { getSource, isRemoteSourceUrl } from "../components/integration-editor/utils";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { ToolsPolicySection } from "../components/integration-editor/tools-policy-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";

import {
  defaultEditorState,
  defaultSkillManifest,
  defaultIntegrationManifest,
  DEFAULT_SKILL_CONTENT,
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
  tab?: PackageEditorTab;
  onTabRequest?: (tab: PackageEditorTab) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const embedded = presentation === "embedded";

  // Schema fields are stored in local state to preserve fields being edited (empty key).
  // Only complete fields are persisted to the manifest via fieldsToSchema.
  const [schemaFields, setSchemaFields] = useState<Record<string, SchemaField[]>>(() =>
    manifestToSchemaFields(initialState.manifest),
  );

  const editor = usePackageEditor({
    type: "agent",
    initialState,
    packageId,
    presentation,
    tab,
    onTabRequest,
    validate: (s) =>
      !embedded && !newPackageContent("agent", s.operations ?? []).trim()
        ? { error: t("editor.errorPrompt"), tab: "files" }
        : null,
    onManifestReplace: (manifest) => setSchemaFields(manifestToSchemaFields(manifest)),
  });
  const { state, setState, updateManifest, activeTab } = editor;

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

  const setManifestRuntimeTools = (next: string[]) =>
    setState((s) => {
      const m = { ...s.manifest };
      setRuntimeTools(m, next);
      return { ...s, manifest: m };
    });

  const agentTabs: Array<{ id: PackageEditorTab; label: string }> = embedded
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

  return (
    <PackageEditorFrame
      editor={editor}
      tabs={agentTabs}
      descriptions={{
        general: t("editor.description.general"),
        schema: t("editor.description.schema"),
        skills: t("editor.description.skills"),
        integrations: t("editor.description.integrations"),
        tools: t("editor.runtimeToolsHint"),
      }}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={editor.metadata}
          onChange={editor.onMetadataChange}
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
    </PackageEditorFrame>
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
  const embedded = presentation === "embedded";
  const editor = usePackageEditor({
    type,
    initialState,
    packageId,
    presentation,
    validate: (s) => {
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

  const pkgTabs: Array<{ id: PackageEditorTab; label: string }> = embedded
    ? [{ id: "general", label: t("editor.tabGeneral") }]
    : [
        { id: "general", label: t("editor.tabGeneral") },
        { id: "files", label: t("files.tabLabel") },
        { id: "json", label: t("editor.tabJson") },
      ];

  return (
    <PackageEditorFrame
      editor={editor}
      tabs={pkgTabs}
      descriptions={
        type === "mcp-server" ? { general: t("mcpServerEditor.description.general") } : undefined
      }
    >
      {editor.activeTab === "general" && (
        <MetadataSection
          value={editor.metadata}
          onChange={editor.onMetadataChange}
          isEdit={embedded}
          surface={embedded ? "settings" : "card"}
        />
      )}
    </PackageEditorFrame>
  );
}

// ─── Integration Editor Inner Form ──────────────────────────────────

function IntegrationEditorInner({
  initialState,
  packageId,
  presentation = "page",
  tab,
  onTabRequest,
  toolInspection,
}: {
  initialState: EditorState;
  packageId: string | undefined;
  /** A page to create; embedded in the integration's Package AFPS to edit. */
  presentation?: Presentation;
  tab?: PackageEditorTab;
  onTabRequest?: (tab: PackageEditorTab) => void;
  /** Embedded: the server's reading of the saved tool catalog, shown with its policy. */
  toolInspection?: IntegrationToolInspection;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const embedded = presentation === "embedded";
  const editor = usePackageEditor({
    type: "integration",
    initialState,
    packageId,
    presentation,
    tab,
    onTabRequest,
    validate: (s) => {
      const source = getSource(s.manifest);
      if (source.kind === "remote" && !isRemoteSourceUrl(source.remoteUrl)) {
        return { error: t("integrationEditor.source.errorRemoteUrl"), tab: "source" };
      }
      return null;
    },
  });
  const { state, activeTab, replaceManifest: onManifestChange } = editor;
  const sectionSurface = embedded ? "settings" : "card";

  // Embedded, the labels are the settings rail's, so heading and rail agree.
  const integrationTabs: Array<{ id: PackageEditorTab; label: string }> = embedded
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
    <PackageEditorFrame
      editor={editor}
      tabs={integrationTabs}
      descriptions={{
        general: t("integrationEditor.description.general"),
        source: t("integrationEditor.description.source"),
        auths: t("integrationEditor.description.auths"),
        tools: t("integrationEditor.description.tools"),
      }}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={editor.metadata}
          onChange={editor.onMetadataChange}
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
        (toolInspection ? (
          <IntegrationToolsSection
            integrationId={packageId ?? "new"}
            inspection={toolInspection}
            edit={{ manifest: state.manifest, onChange: onManifestChange }}
            showBasis={false}
          />
        ) : (
          <ToolsPolicySection
            manifest={state.manifest}
            onChange={onManifestChange}
            surface={sectionSurface}
          />
        ))}
    </PackageEditorFrame>
  );
}

export type IntegrationDefinitionSection = "general" | "source" | "auths" | "tools";

/** An integration's definition, edited inside its settings — see `AgentDefinitionEditor`. */
export function IntegrationDefinitionEditor({
  detail,
  section,
  onSection,
  toolInspection,
}: {
  detail: Versioned<OrgPackageItemDetail>;
  section: IntegrationDefinitionSection;
  onSection: (section: IntegrationDefinitionSection) => void;
  toolInspection: IntegrationToolInspection;
}) {
  return (
    <IntegrationEditorInner
      key={`${detail.id}:${detail.etag}`}
      initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
      packageId={detail.id}
      presentation="embedded"
      tab={section}
      onTabRequest={(next) => onSection(next as IntegrationDefinitionSection)}
      toolInspection={toolInspection}
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
