// SPDX-License-Identifier: Apache-2.0

import { Fragment, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Versioned } from "../hooks/use-packages";
import type {
  AgentDetail,
  IntegrationToolCatalogEntry,
  OrgPackageItemDetail,
} from "@appstrate/shared-types";
import type { AgentDefinitionSection } from "../lib/settings-section-href";
import { EditorDirtyReportContext, type EditorState } from "../hooks/use-editor-state";
import { FormField } from "../components/form-field";
import {
  usePackageEditor,
  type PackageEditorTab,
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
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";

import {
  manifestToSchemaFields,
  manifestSchemaWrapper,
  getResourceEntries,
  setResourceEntries,
  getRuntimeTools,
  setRuntimeTools,
  withNormalizedManifest,
  withOutputTool,
  fieldsToSchema,
} from "../components/agent-editor/utils";
import type { ResourceEntry, SchemaField } from "../components/agent-editor/types";

const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  packageId,
  effectiveTimeoutSeconds,
  tab,
  onTabRequest,
}: {
  initialState: EditorState;
  packageId: string;
  /**
   * Timeout this deployment will actually enforce (server-computed: declared
   * value clamped to `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds`). Read off
   * the agent detail the page already loaded.
   */
  effectiveTimeoutSeconds?: number;
  /** The section is the settings rail's, not the editor's. */
  tab: PackageEditorTab;
  onTabRequest: (tab: PackageEditorTab) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);

  // Schema fields are stored in local state to preserve fields being edited (empty key).
  // Only complete fields are persisted to the manifest via fieldsToSchema.
  const [schemaFields, setSchemaFields] = useState<Record<string, SchemaField[]>>(() =>
    manifestToSchemaFields(initialState.manifest),
  );

  const editor = usePackageEditor({
    type: "agent",
    initialState,
    packageId,
    tab,
    onTabRequest,
    onManifestReplace: (manifest) => setSchemaFields(manifestToSchemaFields(manifest)),
  });
  const { state, setState, updateManifest, activeTab } = editor;

  // Deployment run-timeout ceiling, surfaced as a non-blocking hint under the
  // timeout field. The server sends only `effective_timeout_seconds`
  // (= min(declared, ceiling)), which pins the ceiling EXACTLY when it clamped
  // the saved declaration. When it did not clamp, the ceiling is only known to
  // be >= that value, so we stay silent rather than warn about a number we
  // cannot judge. `undefined` here = no hint.
  const savedTimeout = asNumber(initialState.manifest.timeout);
  const declaredTimeout = asNumber(state.manifest.timeout);
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

  const setManifestRuntimeTools = (next: string[]) =>
    setState((s) => {
      const m = { ...s.manifest };
      setRuntimeTools(m, next);
      return { ...s, manifest: m };
    });

  const resourceTabs = {
    skills: {
      type: "skill",
      title: t("common:nav.skills"),
      emptyLabel: t("editor.skillsEmpty"),
    },
    integrations: {
      type: "integration",
      title: t("common:nav.integrations"),
      emptyLabel: t("editor.integrationsEmpty"),
    },
  } as const;
  const resourceKey =
    activeTab === "skills" || activeTab === "integrations" ? activeTab : undefined;
  const setResources =
    (key: "skills" | "integrations") => (update: (prev: ResourceEntry[]) => ResourceEntry[]) =>
      setState((s) => {
        const m = { ...s.manifest };
        setResourceEntries(m, key, update(getResourceEntries(s.manifest, key)));
        return { ...s, manifest: m };
      });

  return (
    <PackageEditorFrame
      editor={editor}
      tabs={[
        { id: "general", label: t("editor.tabGeneral") },
        { id: "schema", label: t("editor.tabSchema") },
        { id: "skills", label: t("common:nav.skills") },
        { id: "integrations", label: t("common:nav.integrations") },
        // The manifest's `runtime_tools`, not integration packages.
        { id: "tools", label: t("integrationEditor.tabTools") },
      ]}
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
          isEdit
          identityChildren={
            <AgentAppearanceFields manifest={state.manifest} onChange={updateManifest} />
          }
        >
          <div className="flex flex-col gap-2">
            <FormField
              id="meta-timeout"
              label={t("editor.execTimeout")}
              type="number"
              min={1}
              value={declaredTimeout !== undefined ? String(declaredTimeout) : ""}
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
      {activeTab === "tools" && (
        <RuntimeToolsGroup
          selected={getRuntimeTools(state.manifest)}
          onChange={setManifestRuntimeTools}
        />
      )}
      {activeTab === "schema" && (
        <div className="flex flex-col gap-6">
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
      {resourceKey && (
        <ResourceSection
          key={resourceKey}
          {...resourceTabs[resourceKey]}
          selectedEntries={getResourceEntries(state.manifest, resourceKey)}
          onChange={setResources(resourceKey)}
        />
      )}
    </PackageEditorFrame>
  );
}

/**
 * Mounts a definition editor on one draft version and remounts it clean when
 * the draft's ETag moves (its own save, a file saved in Explorer, another tab)
 * — but never over unsaved edits: those stay, and saving them meets the moved
 * draft as a 412 instead of being dropped.
 */
function DraftEditorMount({
  id,
  etag,
  children,
}: {
  id: string;
  etag: string | null | undefined;
  children: ReactNode;
}) {
  const report = useContext(EditorDirtyReportContext);
  const [dirty, setDirty] = useState(false);
  const [mountedEtag, setMountedEtag] = useState(etag);
  if (mountedEtag !== etag && !dirty) setMountedEtag(etag);
  const forward = useCallback(
    (next: boolean) => {
      setDirty(next);
      report(next);
    },
    [report],
  );
  return (
    <EditorDirtyReportContext.Provider value={forward}>
      <Fragment key={`${id}:${mountedEtag}`}>{children}</Fragment>
    </EditorDirtyReportContext.Provider>
  );
}

/**
 * An agent's definition, edited where it is read: inside its settings, one
 * rail section at a time, over ONE draft — moving from Schémas to Skills keeps
 * what was typed. Remounted clean on a new draft ETag (`DraftEditorMount`).
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
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <AgentEditorInner
        initialState={{
          manifest: withNormalizedManifest(detail.manifest ?? {}),
          etag: detail.etag,
        }}
        packageId={detail.id}
        effectiveTimeoutSeconds={detail.effective_timeout_seconds}
        tab={section}
        onTabRequest={(next) => onSection(next as AgentDefinitionSection)}
      />
    </DraftEditorMount>
  );
}

// ─── Package (Skill/MCP Server) Editor Inner Form ─────────────────────────

function PackageEditorInner({
  type,
  initialState,
  packageId,
}: {
  type: "skill" | "mcp-server";
  initialState: EditorState;
  packageId: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const isEdit = packageId !== undefined;
  const editor = usePackageEditor({
    type,
    initialState,
    packageId,
  });

  return (
    <PackageEditorFrame
      editor={editor}
      tabs={[{ id: "general", label: t("editor.tabGeneral") }]}
      descriptions={
        type === "mcp-server" ? { general: t("mcpServerEditor.description.general") } : undefined
      }
    >
      {editor.activeTab === "general" && (
        <MetadataSection
          value={editor.metadata}
          onChange={editor.onMetadataChange}
          isEdit={isEdit}
        />
      )}
    </PackageEditorFrame>
  );
}

// ─── Integration Editor Inner Form ──────────────────────────────────

function IntegrationEditorInner({
  initialState,
  packageId,
  tab,
  onTabRequest,
  toolCatalog,
}: {
  initialState: EditorState;
  packageId: string;
  tab?: PackageEditorTab;
  onTabRequest?: (tab: PackageEditorTab) => void;
  /** Editing: the saved package's tool catalog, shown with the draft's policy. */
  toolCatalog?: IntegrationToolCatalogEntry[];
}) {
  const { t } = useTranslation(["agents", "common"]);
  const isEdit = packageId !== undefined;
  const editor = usePackageEditor({
    type: "integration",
    initialState,
    packageId,
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

  return (
    <PackageEditorFrame
      editor={editor}
      // The labels are the settings rail's, so heading and rail agree.
      tabs={[
        { id: "general", label: t("editor.tabGeneral") },
        { id: "source", label: t("integrationEditor.tabSource") },
        { id: "auths", label: t("integrationEditor.tabAuthMethods") },
        { id: "tools", label: t("integrationEditor.tabTools") },
      ]}
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
          isEdit={isEdit}
        />
      )}

      {activeTab === "source" && (
        <SourceSection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "auths" && (
        <AuthsSection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "tools" && (
        <IntegrationToolsSection
          tools={toolCatalog ?? []}
          edit={{ manifest: state.manifest, onChange: onManifestChange }}
        />
      )}
    </PackageEditorFrame>
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
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <IntegrationEditorInner
        initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
        packageId={detail.id}
        tab={section}
        onTabRequest={(next) => onSection(next as IntegrationDefinitionSection)}
        toolCatalog={toolCatalog}
      />
    </DraftEditorMount>
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
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <PackageEditorInner
        type={type}
        initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
        packageId={detail.id}
      />
    </DraftEditorMount>
  );
}
