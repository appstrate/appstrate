// SPDX-License-Identifier: Apache-2.0

import { Fragment, useCallback, useContext, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Versioned } from "../hooks/use-packages";
import type {
  AgentDetail,
  IntegrationToolCatalogEntry,
  OrgPackageItemDetail,
} from "@appstrate/shared-types";
import { dropRetiredDependencyKeys } from "@appstrate/core/dependencies";
import { asRecord } from "@appstrate/core/safe-json";
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
import { usePackageFileIndex } from "../components/package-files/use-package-file-index";
import { SourceSection } from "../components/integration-editor/source-section";
import { getSource, isRemoteSourceUrl } from "../components/integration-editor/utils";
import { IntegrationIconField } from "../components/integration-editor/integration-icon-field";
import { AuthsSection } from "../components/integration-editor/auths-section";
import { IntegrationToolsSection } from "../components/integration-editor/integration-tools-section";
import { ServerIdentityFill } from "../components/integration-editor/server-identity-fill";
import { encodeIconDataUri } from "../lib/icon-image";
import {
  mergeServerIdentity,
  type ServerIdentityKey,
  type ServerSyncProposal,
  type serverReadAvailability,
} from "../lib/integration-server-sync";
import type { ToolDeclaration } from "../components/integration-editor/integration-tool-policy-section";

import {
  manifestToSchemaFields,
  manifestSchemaWrapper,
  getResourceEntries,
  setResourceEntries,
  fieldsToSchema,
} from "../components/agent-editor/utils";
import type { ResourceEntry, SchemaField } from "../components/agent-editor/types";
import { declareTools } from "../lib/integration-tool-policy";
import type { ToolSnapshotInfo } from "../lib/integration-tool-snapshot";

const isEmptyIcon = (icon: unknown) => typeof icon !== "string" || icon === "";

const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined);

// ─── Agent Editor Inner Form ────────────────────────────────────────

function AgentEditorInner({
  initialState,
  packageId,
  homeSpaceId,
  effectiveTimeoutSeconds,
  tab,
}: {
  initialState: EditorState;
  packageId: string;
  /** The space whose tool approvals judge the agent's selections at save (`null`: no home). */
  homeSpaceId: string | null;
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
      setState((s) => ({ ...s, manifest: { ...s.manifest, [key]: wrapper } }));
    } else {
      setState((s) => {
        const { [key]: _, ...rest } = s.manifest;
        return { ...s, manifest: rest };
      });
    }
  };

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
      ]}
      descriptions={{
        general: t("editor.description.general"),
        schema: t("editor.description.schema"),
        skills: t("editor.description.skills"),
        integrations: t("editor.description.integrations"),
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
          toolPolicySpaceId={homeSpaceId}
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
          // The editor has no field for a retired `dependencies` key.
          manifest: dropRetiredDependencyKeys(detail.manifest ?? {}),
          etag: detail.etag,
        }}
        packageId={detail.id}
        homeSpaceId={detail.home_space_id}
        effectiveTimeoutSeconds={detail.effective_timeout_seconds}
        tab={section}
      />
    </DraftEditorMount>
  );
}

// ─── Package (Skill) Editor Inner Form ─────────────────────────

function PackageEditorInner({
  initialState,
  packageId,
}: {
  initialState: EditorState;
  packageId: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const editor = usePackageEditor({ type: "skill", initialState, packageId, tab: "general" });

  return (
    <PackageEditorFrame editor={editor} tabs={[{ id: "general", label: t("editor.tabGeneral") }]}>
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
  snapshot,
  serverRead,
  toolPolicy,
}: {
  initialState: EditorState;
  packageId: string;
  tab: PackageEditorTab;
  /** The saved package's tool catalog, shown with the draft's policy. */
  toolCatalog: IntegrationToolCatalogEntry[];
  /** The server's last listing, summarised above the table. */
  snapshot: ToolSnapshotInfo;
  /** Whether the draft's server can be read for its identity; `null`: not a remote source. */
  serverRead: ReturnType<typeof serverReadAvailability>;
  /** The space's review and blocks, under the Tools section, given the draft's declaration. */
  toolPolicy?: (declaration: ToolDeclaration) => ReactNode;
}) {
  const { t } = useTranslation(["agents", "common"]);
  // Set by `validate` when it refuses the local server: the Source tab flags its empty fields.
  const [localServerRefused, setLocalServerRefused] = useState(false);
  const editor = usePackageEditor({
    type: "integration",
    initialState,
    packageId,
    tab,
    validate: (s) => {
      const source = getSource(s.manifest);
      setLocalServerRefused(false);
      if (source.kind === "remote" && !isRemoteSourceUrl(source.remoteUrl)) {
        return { error: t("integrationEditor.source.errorRemoteUrl") };
      }
      if (source.kind === "local" && (!source.entryPoint.trim() || !source.command.trim())) {
        setLocalServerRefused(true);
        return { error: t("integrationEditor.source.errorLocalServer") };
      }
      return null;
    },
  });
  const { state, activeTab, replaceManifest: onManifestChange } = editor;
  // The saved draft's files: the local server's entry point is checked against them.
  // Read only for a local source: nothing else checks files.
  const isLocal = getSource(state.manifest).kind === "local";
  const fileIndex = usePackageFileIndex(isLocal ? packageId : undefined);
  const serverFiles = fileIndex.data?.data.map((file) => file.path);
  // Fills the identity the author left empty. A raster the manifest does not accept as is (ICO,
  // large PNG) is re-encoded; one the browser cannot decode is skipped. The icon lands only if the
  // draft still has none.
  const fillIdentity = async (proposal: ServerSyncProposal): Promise<ServerIdentityKey[]> => {
    const proposed = proposal.manifest as Record<string, unknown>;
    // Recorded inside the updater: it sees the draft as it is when applied, not the render's.
    // `flushSync` runs the updater now, so the local is set when it is read.
    let filled: ServerIdentityKey[] = [];
    flushSync(() =>
      editor.setState((s) => {
        const merged = mergeServerIdentity(s.manifest, proposed);
        filled = merged.filled;
        return { ...s, manifest: merged.manifest };
      }),
    );
    if (!proposal.icon_source || proposed.icon) return filled;
    try {
      const icon = await encodeIconDataUri(proposal.icon_source);
      let iconSet = false;
      flushSync(() =>
        editor.setState((s) => {
          if (!isEmptyIcon(s.manifest.icon)) return s;
          iconSet = true;
          return { ...s, manifest: { ...s.manifest, icon } };
        }),
      );
      return iconSet ? [...filled, "icon"] : filled;
    } catch {
      return filled;
    }
  };
  // Declaring a listed tool edits the draft; saving and publishing stay the author's.
  const declaration: ToolDeclaration = {
    declared: new Set(Object.keys(asRecord(state.manifest.tools_policy))),
    saved: !editor.isDirty,
    declare: (names) =>
      editor.setState((s) => ({ ...s, manifest: declareTools(s.manifest, names) })),
  };

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
      after={activeTab === "tools" ? toolPolicy?.(declaration) : undefined}
    >
      {activeTab === "general" && (
        <MetadataSection
          value={editor.metadata}
          onChange={editor.onMetadataChange}
          identityChildren={
            <>
              <IntegrationIconField
                icon={typeof state.manifest.icon === "string" ? state.manifest.icon : undefined}
                onChange={(icon) => editor.updateManifest({ icon })}
              />
              {serverRead && (
                <ServerIdentityFill
                  packageId={packageId}
                  blockedBy={serverRead === "available" ? null : serverRead}
                  apply={fillIdentity}
                />
              )}
            </>
          }
        />
      )}

      {activeTab === "source" && (
        <SourceSection
          manifest={state.manifest}
          onChange={onManifestChange}
          serverFiles={serverFiles}
          // A refused save names the empty required fields of the Source tab.
          showErrors={localServerRefused}
        />
      )}

      {activeTab === "auths" && (
        <AuthsSection manifest={state.manifest} onChange={onManifestChange} />
      )}

      {activeTab === "tools" && (
        <IntegrationToolsSection
          tools={toolCatalog}
          snapshot={snapshot}
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
  toolCatalog,
  snapshot,
  serverRead,
  toolPolicy,
}: {
  detail: Versioned<OrgPackageItemDetail>;
  section: IntegrationDefinitionSection;
  toolCatalog: IntegrationToolCatalogEntry[];
  snapshot: ToolSnapshotInfo;
  /** Whether the draft's remote server can be read for its identity; `null`: not remote. */
  serverRead: ReturnType<typeof serverReadAvailability>;
  /** The space's review and blocks, drawn under the Tools section. */
  toolPolicy?: (declaration: ToolDeclaration) => ReactNode;
}) {
  return (
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <IntegrationEditorInner
        initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
        packageId={detail.id}
        tab={section}
        toolCatalog={toolCatalog}
        snapshot={snapshot}
        serverRead={serverRead}
        toolPolicy={toolPolicy}
      />
    </DraftEditorMount>
  );
}

/** A skill's definition, edited inside its settings. Identité is the one form: SKILL.md and references are files, changed in Explorer › Fichiers. */
export function PackageDefinitionEditor({ detail }: { detail: Versioned<OrgPackageItemDetail> }) {
  return (
    <DraftEditorMount id={detail.id} etag={detail.etag}>
      <PackageEditorInner
        initialState={{ manifest: detail.manifest ?? {}, etag: detail.etag }}
        packageId={detail.id}
      />
    </DraftEditorMount>
  );
}
