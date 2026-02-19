import { useState, useRef, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useFlowDetail } from "../hooks/use-flows";
import { useCreateFlow, useUpdateFlow } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { MetadataSection } from "../components/flow-editor/metadata-section";
import { SchemaSection } from "../components/flow-editor/schema-section";
import { ExecutionSection } from "../components/flow-editor/execution-section";
import { PackageSection } from "../components/flow-editor/package-section";
import { ResourceSection } from "../components/flow-editor/resource-section";
import { EditorTabs } from "../components/flow-editor/editor-tabs";
import { PromptEditor } from "../components/flow-editor/prompt-editor";
import { ServicePicker } from "../components/flow-editor/service-picker";
import { JsonEditor } from "../components/flow-editor/json-editor";
import { Spinner } from "../components/spinner";
import type { FlowFormState, EditorTab } from "../components/flow-editor/types";
import {
  defaultFormState,
  detailToFormState,
  assemblePayload,
  toResourceEntry,
} from "../components/flow-editor/utils";
import type { FlowDetail } from "@appstrate/shared-types";

// --- Inner form component (receives initial state, no effects needed) ---

function FlowEditorForm({
  initialState,
  detail,
  flowId,
  isEdit,
  userEmail,
}: {
  initialState: FlowFormState;
  detail: FlowDetail | null;
  flowId: string | undefined;
  isEdit: boolean;
  userEmail: string;
}) {
  const navigate = useNavigate();
  const createFlow = useCreateFlow();
  const updateFlow = useUpdateFlow(flowId || "");

  const [form, setForm] = useState<FlowFormState>(initialState);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>("general");
  const needsFullRefresh = useRef(false);

  // Sync from server after API mutations refetch detail
  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync from server data to local form state */
  useEffect(() => {
    if (!detail) return;
    if (needsFullRefresh.current) {
      needsFullRefresh.current = false;
      setForm(detailToFormState(detail));
    } else {
      setForm((prev) => ({
        ...prev,
        skills: (detail.requires.skills ?? []).map(toResourceEntry),
        extensions: (detail.requires.extensions ?? []).map(toResourceEntry),
      }));
    }
  }, [detail]);

  const handleSubmit = () => {
    setError(null);

    if (!form.metadata.name || !form.metadata.displayName || !form.metadata.description) {
      setError("Les champs identifiant, nom d'affichage et description sont requis.");
      setActiveTab("general");
      return;
    }

    if (!form.prompt.trim()) {
      setError("Le prompt est requis.");
      setActiveTab("prompt");
      return;
    }

    const payload = assemblePayload(form, userEmail);

    if (isEdit && detail) {
      updateFlow.mutate(
        { ...payload, updatedAt: detail.updatedAt! },
        { onError: (err) => setError(err.message) },
      );
    } else {
      createFlow.mutate(payload, {
        onError: (err) => setError(err.message),
      });
    }
  };

  const isPending = createFlow.isPending || updateFlow.isPending;
  const canEdit = isEdit && detail?.source === "user" && !!detail?.updatedAt;

  const handleJsonApply = (newState: FlowFormState) => {
    setForm(newState);
    setActiveTab("general");
  };

  return (
    <div className="flow-editor">
      <nav className="breadcrumb">
        <Link to="/">Flows</Link>
        <span className="separator">/</span>
        {isEdit && detail ? (
          <>
            <Link to={`/flows/${flowId}`}>{detail.displayName}</Link>
            <span className="separator">/</span>
            <span className="current">Modifier</span>
          </>
        ) : (
          <span className="current">Nouveau flow</span>
        )}
      </nav>

      {error && <div className="editor-error">{error}</div>}

      <EditorTabs activeTab={activeTab} onTabChange={setActiveTab} />

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
          {isEdit && (
            <PackageSection
              detail={detail}
              flowId={flowId}
              canEdit={canEdit}
              onPackageUploaded={() => {
                needsFullRefresh.current = true;
              }}
            />
          )}
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
            title="Entrees (input)"
            mode="input"
            fields={form.inputSchema}
            onChange={(inputSchema) => setForm((s) => ({ ...s, inputSchema }))}
          />
          <SchemaSection
            title="Sorties (output)"
            mode="output"
            fields={form.outputSchema}
            onChange={(outputSchema) => setForm((s) => ({ ...s, outputSchema }))}
          />
          <SchemaSection
            title="Configuration"
            mode="config"
            fields={form.configSchema}
            onChange={(configSchema) => setForm((s) => ({ ...s, configSchema }))}
          />
        </>
      )}

      {activeTab === "skills" && (
        <ResourceSection
          type="skills"
          title="Skills"
          emptyLabel="Aucun skill dans la bibliotheque. Ajoutez-en depuis la page Bibliotheque."
          selectedIds={form.skills.map((s) => s.id)}
          onChange={(ids) => setForm((s) => ({ ...s, skills: ids.map((id) => ({ id })) }))}
        />
      )}

      {activeTab === "extensions" && (
        <ResourceSection
          type="extensions"
          title="Extensions"
          emptyLabel="Aucune extension dans la bibliotheque. Ajoutez-en depuis la page Bibliotheque."
          selectedIds={form.extensions.map((e) => e.id)}
          onChange={(ids) => setForm((s) => ({ ...s, extensions: ids.map((id) => ({ id })) }))}
        />
      )}

      {activeTab === "json" && (
        <JsonEditor form={form} userEmail={userEmail} onApply={handleJsonApply} />
      )}

      {activeTab !== "json" && (
        <div className="editor-actions">
          <button type="button" onClick={() => navigate(isEdit ? `/flows/${flowId}` : "/")}>
            Annuler
          </button>
          <button type="button" className="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? <Spinner /> : isEdit ? "Enregistrer" : "Creer"}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Outer wrapper: handles loading, auth, and routing ---

export function FlowEditorPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isOrgAdmin } = useOrg();
  const isEdit = !!flowId;

  const { data: detail, isLoading } = useFlowDetail(flowId);

  if (!isOrgAdmin) {
    return (
      <div className="empty-state">
        <p>Acces reserve aux administrateurs.</p>
      </div>
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
    return (
      <div className="empty-state">
        <p>Flow introuvable.</p>
      </div>
    );
  }

  if (isEdit && detail && detail.source !== "user") {
    navigate(`/flows/${flowId}`, { replace: true });
    return null;
  }

  const initialState = isEdit && detail ? detailToFormState(detail) : defaultFormState();

  return (
    <FlowEditorForm
      key={flowId ?? "new"}
      initialState={initialState}
      detail={detail ?? null}
      flowId={flowId}
      isEdit={isEdit}
      userEmail={user?.email ?? ""}
    />
  );
}
