import { useState, useEffect } from "react";
import { useParams, useNavigate, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { useFlowDetail, usePackageDetail, type PackageType } from "../hooks/use-packages";
import {
  useCreateFlow,
  useUpdateFlow,
  useCreatePackage,
  useUpdatePackage,
} from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";

// Flow editor components
import { MetadataSection } from "../components/flow-editor/metadata-section";
import { SchemaSection } from "../components/flow-editor/schema-section";
import { ExecutionSection } from "../components/flow-editor/execution-section";
import { ResourceSection } from "../components/flow-editor/resource-section";
import { PromptEditor } from "../components/flow-editor/prompt-editor";
import { ServicePicker } from "../components/flow-editor/service-picker";
import { JsonEditor } from "../components/flow-editor/json-editor";
import { ContentEditor } from "../components/package-editor/content-editor";
import { Spinner } from "../components/spinner";
import { EmptyState } from "../components/page-states";

import type { FlowFormState } from "../components/flow-editor/types";
import {
  defaultFormState as flowDefaultFormState,
  detailToFormState as flowDetailToFormState,
  assemblePayload as flowAssemblePayload,
  toResourceEntry,
} from "../components/flow-editor/utils";
import type { PackageFormState } from "../lib/package-type-modules";
import { getPackageTypeModule } from "../lib/package-type-modules";

type GenericEditorTab =
  | "general"
  | "prompt"
  | "services"
  | "schema"
  | "skills"
  | "extensions"
  | "content"
  | "json";

// ─── Flow Editor Inner Form ─────────────────────────────────────────

function FlowEditorInner({
  initialState,
  detail,
  packageId,
  isEdit,
}: {
  initialState: FlowFormState;
  detail: { requires: { skills: unknown[]; extensions: unknown[] }; lockVersion?: number } | null;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const navigate = useNavigate();
  const createFlow = useCreateFlow();
  const updateFlow = useUpdateFlow(packageId || "");

  const [form, setForm] = useState<FlowFormState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");

  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync from server data to local form state */
  useEffect(() => {
    if (!detail) return;
    setForm((prev) => ({
      ...prev,
      skills: (
        detail.requires.skills as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry),
      extensions: (
        detail.requires.extensions as {
          id: string;
          version?: string;
          name?: string;
          description?: string;
        }[]
      ).map(toResourceEntry),
    }));
  }, [detail]);

  const handleSubmit = () => {
    setError(null);
    if (!form.metadata.id || !form.metadata.displayName) {
      setError(t("editor.errorRequired"));
      setActiveTab("general");
      return;
    }
    if (!form.prompt.trim()) {
      setError(t("editor.errorPrompt"));
      setActiveTab("prompt");
      return;
    }
    const payload = flowAssemblePayload(form);
    if (isEdit && detail) {
      updateFlow.mutate(
        { ...payload, lockVersion: detail.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createFlow.mutate(payload, { onError: (err) => setError(err.message) });
    }
  };

  const isPending = createFlow.isPending || updateFlow.isPending;
  const handleJsonApply = (newState: FlowFormState) => {
    setForm(newState);
    setActiveTab("general");
  };

  const flowTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "prompt", label: t("editor.tabPrompt") },
    { id: "services", label: t("editor.tabServices") },
    { id: "schema", label: t("editor.tabSchema") },
    { id: "skills", label: t("editor.tabSkills") },
    { id: "extensions", label: t("editor.tabExtensions") },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <div className="flow-editor">
      <nav className="breadcrumb">
        <Link to="/">{t("detail.breadcrumb")}</Link>
        <span className="separator">/</span>
        {isEdit && detail ? (
          <>
            <Link to={`/flows/${packageId}`}>{form.metadata.displayName || packageId}</Link>
            <span className="separator">/</span>
            <span className="current">{t("editor.breadcrumbEdit")}</span>
          </>
        ) : (
          <span className="current">{t("editor.breadcrumbNew")}</span>
        )}
      </nav>

      {error && <div className="editor-error">{error}</div>}

      <div className="exec-tabs">
        {flowTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <>
          <MetadataSection
            value={form.metadata}
            onChange={(metadata) => setForm((s) => ({ ...s, metadata }))}
            isEdit={isEdit}
          />
          <ExecutionSection
            value={form.execution}
            onChange={(execution) => setForm((s) => ({ ...s, execution }))}
          />
        </>
      )}
      {activeTab === "prompt" && (
        <PromptEditor
          value={form.prompt}
          onChange={(prompt) => setForm((s) => ({ ...s, prompt }))}
        />
      )}
      {activeTab === "services" && (
        <ServicePicker
          value={form.services}
          onChange={(services) => setForm((s) => ({ ...s, services }))}
        />
      )}
      {activeTab === "schema" && (
        <>
          <SchemaSection
            title={t("editor.inputTitle")}
            mode="input"
            fields={form.inputSchema}
            onChange={(inputSchema) => setForm((s) => ({ ...s, inputSchema }))}
          />
          <SchemaSection
            title={t("editor.outputTitle")}
            mode="output"
            fields={form.outputSchema}
            onChange={(outputSchema) => setForm((s) => ({ ...s, outputSchema }))}
          />
          <SchemaSection
            title={t("editor.configTitle")}
            mode="config"
            fields={form.configSchema}
            onChange={(configSchema) => setForm((s) => ({ ...s, configSchema }))}
          />
        </>
      )}
      {activeTab === "skills" && (
        <ResourceSection
          type="skill"
          title={t("editor.tabSkills")}
          emptyLabel={t("editor.skillsEmpty")}
          selectedEntries={form.skills}
          onChange={(entries) => setForm((s) => ({ ...s, skills: entries }))}
        />
      )}
      {activeTab === "extensions" && (
        <ResourceSection
          type="extension"
          title={t("editor.tabExtensions")}
          emptyLabel={t("editor.extensionsEmpty")}
          selectedEntries={form.extensions}
          onChange={(entries) => setForm((s) => ({ ...s, extensions: entries }))}
        />
      )}
      {activeTab === "json" && <JsonEditor form={form} onApply={handleJsonApply} />}

      {activeTab !== "json" && (
        <div className="editor-actions">
          <button type="button" onClick={() => navigate(isEdit ? `/flows/${packageId}` : "/")}>
            {t("btn.cancel")}
          </button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Package (Skill/Extension) Editor Inner Form ────────────────────

function PackageEditorInner({
  type,
  initialState,
  packageId,
  isEdit,
}: {
  type: "skill" | "extension";
  initialState: PackageFormState;
  packageId: string | undefined;
  isEdit: boolean;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const navigate = useNavigate();
  const createPkg = useCreatePackage(type);
  const updatePkg = useUpdatePackage(type, packageId || "");

  const [form, setForm] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<GenericEditorTab>("general");

  if (form._type !== "skill" && form._type !== "extension") return null;

  const handleSubmit = () => {
    setError(null);
    const meta = form.metadata;
    if (!meta.id || !meta.displayName) {
      setError(t("editor.errorRequired"));
      setActiveTab("general");
      return;
    }
    if (!form.content.trim()) {
      setError(t("editor.errorContent", { defaultValue: "Le contenu est requis." }));
      setActiveTab("content");
      return;
    }

    const module = getPackageTypeModule(type);
    const payload = module.assemblePayload(form);
    if (isEdit) {
      updatePkg.mutate({ ...payload, lockVersion: form._lockVersion! } as never, {
        onError: (err) => setError(err.message),
      });
    } else {
      createPkg.mutate({ id: meta.id, ...payload } as never, {
        onError: (err) => setError(err.message),
      });
    }
  };

  const isPending = createPkg.isPending || updatePkg.isPending;

  const pkgTabs: Array<{ id: GenericEditorTab; label: string }> = [
    { id: "general", label: t("editor.tabGeneral") },
    { id: "content", label: t("packages.content") },
    { id: "json", label: t("editor.tabJson") },
  ];

  const typePath = `${type}s`;
  const language = type === "skill" ? "markdown" : "typescript";

  return (
    <div className="flow-editor">
      <nav className="breadcrumb">
        <Link to={`/?tab=${typePath}`}>{t(`packages.type.${typePath}`, { ns: "settings" })}</Link>
        <span className="separator">/</span>
        {isEdit && packageId ? (
          <>
            <Link to={`/${typePath}/${packageId}`}>{form.metadata.displayName || packageId}</Link>
            <span className="separator">/</span>
            <span className="current">{t("editor.breadcrumbEdit")}</span>
          </>
        ) : (
          <span className="current">{t("editor.breadcrumbNew")}</span>
        )}
      </nav>

      {error && <div className="editor-error">{error}</div>}

      <div className="exec-tabs">
        {pkgTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "general" && (
        <MetadataSection
          value={form.metadata}
          onChange={(metadata) => setForm((s) => ({ ...s, metadata }))}
          isEdit={isEdit}
        />
      )}

      {activeTab === "content" && (
        <ContentEditor
          value={form.content}
          onChange={(content) => setForm((s) => ({ ...s, content }))}
          language={language}
        />
      )}

      {activeTab === "json" && (
        <div className="prompt-editor-wrapper">
          <pre className="state-json">{JSON.stringify(form, null, 2)}</pre>
        </div>
      )}

      {activeTab !== "json" && (
        <div className="editor-actions">
          <button
            type="button"
            onClick={() => navigate(isEdit ? `/${typePath}/${packageId}` : `/?tab=${typePath}`)}
          >
            {t("btn.cancel")}
          </button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Page Wrapper ───────────────────────────────────────────────────

export function PackageEditorPage({ type }: { type: "flow" | "skill" | "extension" }) {
  const { t } = useTranslation(["flows", "common"]);
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope ? `${scope}/${name}` : undefined;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isOrgAdmin, currentOrg } = useOrg();
  const isEdit = !!scope;

  // Load detail for editing
  const flowQuery = useFlowDetail(type === "flow" && isEdit ? packageId : undefined);
  const pkgQuery = usePackageDetail(
    type === "flow" ? "skill" : (type as PackageType),
    type !== "flow" && isEdit ? packageId : undefined,
  );

  const isLoading = type === "flow" ? flowQuery.isLoading : pkgQuery.isLoading;
  const detail = type === "flow" ? flowQuery.data : pkgQuery.data;

  if (!isOrgAdmin) {
    return (
      <EmptyState message={t("editor.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <button>{t("btn.back")}</button>
        </Link>
      </EmptyState>
    );
  }

  if (isEdit && isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (isEdit && !detail) {
    return <Navigate to="/" replace />;
  }

  if (isEdit && detail && (detail as { source?: string }).source === "built-in") {
    navigate(`/${type === "flow" ? "flows" : `${type}s`}/${packageId}`, { replace: true });
    return null;
  }

  // Flow editor
  if (type === "flow") {
    const flowDetail = flowQuery.data;
    const initialState =
      isEdit && flowDetail
        ? flowDetailToFormState(flowDetail)
        : flowDefaultFormState(currentOrg?.slug, user?.email);

    return (
      <FlowEditorInner
        key={packageId ?? "new"}
        initialState={initialState}
        detail={flowDetail ?? null}
        packageId={packageId}
        isEdit={isEdit}
      />
    );
  }

  // Skill/Extension editor
  const module = getPackageTypeModule(type);
  const pkgDetail = pkgQuery.data;

  const initialState: PackageFormState =
    isEdit && pkgDetail
      ? module.detailToFormState({
          id: pkgDetail.id,
          displayName: pkgDetail.name ?? pkgDetail.id,
          description: pkgDetail.description ?? "",
          source: pkgDetail.source ?? "local",
          version: pkgDetail.version,
          content: pkgDetail.content,
          updatedAt: pkgDetail.updatedAt,
          manifestName: pkgDetail.manifestName,
          lockVersion: pkgDetail.lockVersion,
        })
      : module.defaultFormState(currentOrg?.slug, user?.email);

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
