import { useState, useEffect } from "react";
import { useParams, useNavigate, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePackageDetail } from "../hooks/use-packages";
import { useCreatePackage, useUpdatePackage } from "../hooks/use-mutations";
import type { OrgPackageItemDetail, PackageType } from "@appstrate/shared-types";
import { useAuth } from "../hooks/use-auth";
import { useOrg, usePackageOwnership } from "../hooks/use-org";
import { packageDetailPath, packageListPath } from "../lib/package-paths";

// Flow editor components
import { MetadataSection } from "../components/flow-editor/metadata-section";
import { SchemaSection } from "../components/flow-editor/schema-section";
import { ExecutionSection } from "../components/flow-editor/execution-section";
import { ResourceSection } from "../components/flow-editor/resource-section";
import { PromptEditor } from "../components/flow-editor/prompt-editor";
import { ProviderPicker } from "../components/flow-editor/provider-picker";
import { JsonEditor } from "../components/flow-editor/json-editor";
import { ContentEditor } from "../components/package-editor/content-editor";
import { ProviderEditorInner } from "../components/provider-editor/provider-editor-inner";
import { Spinner } from "../components/spinner";
import { EmptyState } from "../components/page-states";
import { useProviders } from "../hooks/use-providers";

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
  | "providers"
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
  const createFlow = useCreatePackage("flow");
  const updateFlow = useUpdatePackage("flow", packageId || "");

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
    const { prompt, ...payload } = flowAssemblePayload(form);
    const body = { ...payload, content: prompt };
    if (isEdit && detail) {
      updateFlow.mutate(
        { ...body, lockVersion: detail.lockVersion! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createFlow.mutate(body, { onError: (err) => setError(err.message) });
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
    { id: "providers", label: t("editor.tabServices") },
    { id: "schema", label: t("editor.tabSchema") },
    { id: "skills", label: t("editor.tabSkills") },
    { id: "extensions", label: t("editor.tabExtensions") },
    { id: "json", label: t("editor.tabJson") },
  ];

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to="/" className="text-muted-foreground hover:text-foreground">
          {t("detail.breadcrumb")}
        </Link>
        <span className="opacity-50">/</span>
        {isEdit && detail ? (
          <>
            <Link
              to={`/flows/${packageId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {form.metadata.displayName || packageId}
            </Link>
            <span className="opacity-50">/</span>
            <span>{t("editor.breadcrumbEdit")}</span>
          </>
        ) : (
          <span>{t("editor.breadcrumbNew")}</span>
        )}
      </nav>

      {error && (
        <div className="mb-4 rounded-md bg-destructive/15 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as GenericEditorTab)}
        className="mb-4"
      >
        <TabsList className="overflow-x-auto">
          {flowTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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
      {activeTab === "providers" && (
        <ProviderPicker
          value={form.providers}
          onChange={(providers) => setForm((s) => ({ ...s, providers }))}
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
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-border">
          <Button
            variant="outline"
            type="button"
            onClick={() => navigate(isEdit ? `/flows/${packageId}` : "/")}
          >
            {t("btn.cancel")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
          </Button>
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

  const language = type === "skill" ? "markdown" : "typescript";

  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link to={packageListPath(type)} className="text-muted-foreground hover:text-foreground">
          {t(`packages.type.${type}s`, { ns: "settings" })}
        </Link>
        <span className="opacity-50">/</span>
        {isEdit && packageId ? (
          <>
            <Link
              to={packageDetailPath(type, packageId)}
              className="text-muted-foreground hover:text-foreground"
            >
              {form.metadata.displayName || packageId}
            </Link>
            <span className="opacity-50">/</span>
            <span>{t("editor.breadcrumbEdit")}</span>
          </>
        ) : (
          <span>{t("editor.breadcrumbNew")}</span>
        )}
      </nav>

      {error && (
        <div className="mb-4 rounded-md bg-destructive/15 text-destructive text-sm px-3 py-2">
          {error}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as GenericEditorTab)}
        className="mb-4"
      >
        <TabsList className="overflow-x-auto">
          {pkgTabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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
        <div className="rounded-lg border border-border overflow-hidden my-4">
          <pre className="p-4 text-xs font-mono overflow-auto max-h-[600px] bg-card">
            {JSON.stringify(form, null, 2)}
          </pre>
        </div>
      )}

      {activeTab !== "json" && (
        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-border">
          <Button
            variant="outline"
            type="button"
            onClick={() =>
              navigate(isEdit ? packageDetailPath(type, packageId!) : packageListPath(type))
            }
          >
            {t("btn.cancel")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? t("btn.save") : t("btn.create")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page Wrapper ───────────────────────────────────────────────────

export function PackageEditorPage({ type }: { type: PackageType }) {
  const { t } = useTranslation(["flows", "common"]);
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = scope ? `${scope}/${name}` : undefined;
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isOrgAdmin, currentOrg } = useOrg();
  const { isOwned } = usePackageOwnership(packageId);
  const isEdit = !!scope;

  // Load detail for editing
  const flowQuery = usePackageDetail("flow", type === "flow" && isEdit ? packageId : undefined);
  const pkgQuery = usePackageDetail(
    type,
    type !== "flow" && type !== "provider" && isEdit ? packageId : undefined,
  );
  const providersQuery = useProviders();

  const isLoading =
    type === "flow"
      ? flowQuery.isLoading
      : type === "provider"
        ? providersQuery.isLoading
        : pkgQuery.isLoading;
  const detail =
    type === "flow"
      ? flowQuery.data
      : type === "provider"
        ? providersQuery.data?.providers.find((p) => p.id === packageId)
        : pkgQuery.data;

  if (!isOrgAdmin) {
    return (
      <EmptyState message={t("editor.adminOnly")} icon={ShieldAlert}>
        <Link to="/">
          <Button variant="outline">{t("btn.back")}</Button>
        </Link>
      </EmptyState>
    );
  }

  if (isEdit && isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Spinner />
      </div>
    );
  }

  if (isEdit && !detail) {
    return <Navigate to="/" replace />;
  }

  if (isEdit && detail && (detail as { source?: string }).source === "system") {
    navigate(packageDetailPath(type, packageId!), { replace: true });
    return null;
  }

  if (isEdit && !isOwned) {
    navigate(packageDetailPath(type, packageId!), { replace: true });
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

  // Provider editor — uses dedicated provider API
  if (type === "provider") {
    const editProvider = isEdit
      ? (providersQuery.data?.providers.find((p) => p.id === packageId) ?? null)
      : null;

    return (
      <ProviderEditorInner
        key={packageId ?? "new"}
        provider={editProvider}
        isEdit={isEdit}
        packageId={packageId}
        orgSlug={currentOrg?.slug}
      />
    );
  }

  // Skill/Extension editor (flow/provider returned early above — pkgQuery is always OrgPackageItemDetail here)
  const module = getPackageTypeModule(type);
  const pkgDetail = pkgQuery.data as OrgPackageItemDetail | undefined;

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
