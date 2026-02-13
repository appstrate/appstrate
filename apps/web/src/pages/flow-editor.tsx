import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useFlowDetail } from "../hooks/use-flows";
import { useCreateFlow, useUpdateFlow } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { MetadataSection } from "../components/flow-editor/metadata-section";
import { SchemaSection } from "../components/flow-editor/schema-section";
import { ExecutionSection } from "../components/flow-editor/execution-section";
import { SkillsSection } from "../components/flow-editor/skills-section";
import { EditorTabs } from "../components/flow-editor/editor-tabs";
import { PromptEditor } from "../components/flow-editor/prompt-editor";
import { ServicePicker } from "../components/flow-editor/service-picker";
import { JsonEditor } from "../components/flow-editor/json-editor";
import { Spinner } from "../components/spinner";
import type { FlowFormState, EditorTab } from "../components/flow-editor/types";
import { defaultFormState, detailToFormState, assemblePayload } from "../components/flow-editor/utils";
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
  const [jsonMode, setJsonMode] = useState(false);

  const handleSubmit = () => {
    setError(null);

    if (!form.metadata.name || !form.metadata.displayName || !form.metadata.description) {
      setError("Les champs identifiant, nom d'affichage et description sont requis.");
      setJsonMode(false);
      setActiveTab("general");
      return;
    }

    if (!form.prompt.trim()) {
      setError("Le prompt est requis.");
      setJsonMode(false);
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

  const handleJsonApply = (newState: FlowFormState) => {
    setForm(newState);
    setJsonMode(false);
  };

  return (
    <div className="flow-editor">
      <div className="editor-top-bar">
        <nav className="breadcrumb" style={{ marginBottom: 0 }}>
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

        <div className="result-view-toggle">
          <button
            type="button"
            className={`result-toggle-btn${!jsonMode ? " active" : ""}`}
            onClick={() => setJsonMode(false)}
          >
            Visuel
          </button>
          <button
            type="button"
            className={`result-toggle-btn${jsonMode ? " active" : ""}`}
            onClick={() => setJsonMode(true)}
          >
            JSON
          </button>
        </div>
      </div>

      {error && <div className="editor-error">{error}</div>}

      {jsonMode ? (
        <JsonEditor form={form} userEmail={userEmail} onApply={handleJsonApply} />
      ) : (
        <>
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
            </>
          )}

          {activeTab === "prompt" && (
            <PromptEditor
              value={form.prompt}
              onChange={(prompt) => setForm((s) => ({ ...s, prompt }))}
              configFields={form.configSchema}
              stateFields={form.stateSchema}
              inputFields={form.inputSchema}
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
              <SchemaSection
                title="Etat persistant"
                mode="state"
                fields={form.stateSchema}
                onChange={(stateSchema) => setForm((s) => ({ ...s, stateSchema }))}
              />
            </>
          )}

          {activeTab === "skills" && (
            <SkillsSection
              value={form.skills}
              onChange={(skills) => setForm((s) => ({ ...s, skills }))}
            />
          )}
        </>
      )}

      <div className="editor-actions">
        <button type="button" onClick={() => navigate(isEdit ? `/flows/${flowId}` : "/")}>
          Annuler
        </button>
        <button type="button" className="primary" onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Spinner /> : isEdit ? "Enregistrer" : "Creer"}
        </button>
      </div>
    </div>
  );
}

// --- Outer wrapper: handles loading, auth, and routing ---

export function FlowEditorPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const navigate = useNavigate();
  const { isAdmin, user } = useAuth();
  const isEdit = !!flowId;

  const { data: detail, isLoading } = useFlowDetail(flowId);

  if (!isAdmin) {
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
