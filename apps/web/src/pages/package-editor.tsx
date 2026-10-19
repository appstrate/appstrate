// SPDX-License-Identifier: Apache-2.0

import { Fragment, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Versioned } from "../hooks/use-packages";
import type {
  AgentDetail,
  IntegrationToolCatalogEntry,
  OrgPackageItemDetail,
} from "@appstrate/shared-types";
import { $api } from "../api/client";
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
import { IntegrationIconField } from "../components/integration-editor/integration-icon-field";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import type { ServerSyncResult } from "../components/integration-editor/sync-from-server";

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
import { INTEGRATION_DOC, mergeServerSync, serverSyncBody } from "../lib/integration-server-sync";
import { fileTextOperation } from "../lib/package-file-drafts";
import { encodeIconDataUri } from "../lib/icon-image";

const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  packageId,
  effectiveTimeoutSeconds,
  tab,
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
}) {
  const { t } = useTranslation(["agents", "common"]);

  const editor = usePackageEditor({
    type: "agent",
    initialState,
    packageId,
    tab,
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

  const schemaFields = manifestToSchemaFields(state.manifest);
  const getSchemaFields = (key: "input" | "output") => schemaFields[key] ?? [];

  const onSchemaChange = (key: "input" | "output") => (fields: SchemaField[]) => {
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
          identityChildren={
            <AgentAppearanceFields
              packageId={packageId}
              manifest={state.manifest}
              onChange={updateManifest}
            />
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
}: {
  detail: Versioned<AgentDetail>;
  section: AgentDefinitionSection;
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
  const editor = usePackageEditor({ type, initialState, packageId, tab: "general" });

  return (
    <PackageEditorFrame
      editor={editor}
      tabs={[{ id: "general", label: t("editor.tabGeneral") }]}
      descriptions={
        type === "mcp-server" ? { general: t("mcpServerEditor.description.general") } : undefined
      }
    >
      <MetadataSection value={editor.metadata} onChange={editor.onMetadataChange} />
    </PackageEditorFrame>
  );
}

// ─── Integration Editor Inner Form ──────────────────────────────────

function IntegrationEditorInner({
  initialState,
  packageId,
  tab,
  toolCatalog,
  canSync,
}: {
  initialState: EditorState;
  packageId: string;
  tab: PackageEditorTab;
  /** The saved package's tool catalog, shown with the draft's policy. */
  toolCatalog: IntegrationToolCatalogEntry[];
  /** The draft's server can be asked for its tools. */
  canSync: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const editor = usePackageEditor({
    type: "integration",
    initialState,
    packageId,
    tab,
    validate: (s) => {
      const source = getSource(s.manifest);
      if (source.kind === "remote" && !isRemoteSourceUrl(source.remoteUrl)) {
        return { error: t("integrationEditor.source.errorRemoteUrl") };
      }
      return null;
    },
  });
  const { state, activeTab, replaceManifest: onManifestChange } = editor;
  const [syncResult, setSyncResult] = useState<ServerSyncResult | null>(null);

  // A raster the manifest does not accept as is (ICO, large PNG) is re-encoded here; one the
  // browser cannot decode is skipped. The encoding is async: the icon lands only if the draft
  // still has none.
  const fillIcon = (proposal: { icon_source: string | null; manifest: { icon?: string } }) => {
    if (!proposal.icon_source || proposal.manifest.icon) return;
    void encodeIconDataUri(proposal.icon_source)
      .then((icon) => {
        editor.setState((s) => (s.manifest.icon ? s : { ...s, manifest: { ...s.manifest, icon } }));
      })
      .catch(() => {});
  };

  const sync = $api.useMutation("post", "/api/integrations/{packageId}/discover", {
    meta: { errorHandledByCaller: true },
    onSuccess: (proposal) => {
      editor.setState((s) => ({ ...s, manifest: mergeServerSync(s.manifest, proposal) }));
      // `null` when the package already has an `INTEGRATION.md`, which a sync never replaces.
      const { instructions } = proposal;
      setSyncResult({
        count: proposal.tools.length,
        warnings: proposal.warnings,
        docProposed: Boolean(instructions),
      });
      if (instructions) {
        const operation = fileTextOperation(INTEGRATION_DOC, instructions);
        editor.setState((s) =>
          (s.operations ?? []).some((o) => o.op === "write" && o.path === INTEGRATION_DOC)
            ? s
            : { ...s, operations: [...(s.operations ?? []), operation] },
        );
      }
      fillIcon(proposal);
    },
  });

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
          identityChildren={
            <IntegrationIconField
              icon={typeof state.manifest.icon === "string" ? state.manifest.icon : undefined}
              onChange={(icon) => editor.updateManifest({ icon })}
            />
          }
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
          tools={toolCatalog}
          edit={{ manifest: state.manifest, onChange: onManifestChange }}
          sync={
            canSync
              ? {
                  run: (connectionId) =>
                    sync.mutate({
                      params: { path: { packageId } },
                      body: serverSyncBody(connectionId),
                    }),
                  isPending: sync.isPending,
                  error: sync.error,
                  result: syncResult,
                }
              : undefined
          }
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
  toolCatalog,
  canSync,
}: {
  detail: Versioned<OrgPackageItemDetail>;
  section: IntegrationDefinitionSection;
  toolCatalog: IntegrationToolCatalogEntry[];
  /** The draft is served by a Streamable HTTP server at a fixed URL the caller may read. */
  canSync: boolean;
}) {
  return (
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <IntegrationEditorInner
        initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
        packageId={detail.id}
        tab={section}
        toolCatalog={toolCatalog}
        canSync={canSync}
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
