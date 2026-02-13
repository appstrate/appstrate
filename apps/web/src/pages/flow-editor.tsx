import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useFlowDetail } from "../hooks/use-flows";
import { useCreateFlow, useUpdateFlow } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { MetadataSection } from "../components/flow-editor/metadata-section";
import { PromptSection } from "../components/flow-editor/prompt-section";
import { ServicesSection } from "../components/flow-editor/services-section";
import { SchemaSection } from "../components/flow-editor/schema-section";
import { ExecutionSection } from "../components/flow-editor/execution-section";
import { SkillsSection } from "../components/flow-editor/skills-section";
import { Spinner } from "../components/spinner";
import type { ServiceEntry } from "../components/flow-editor/services-section";
import type { SchemaField } from "../components/flow-editor/schema-section";
import type { ExecutionSettings } from "../components/flow-editor/execution-section";
import type { SkillEntry } from "../components/flow-editor/skills-section";
import type { FlowDetail } from "@appstrate/shared-types";

interface FlowFormState {
  metadata: {
    name: string;
    displayName: string;
    description: string;
    author: string;
    tags: string[];
  };
  prompt: string;
  services: ServiceEntry[];
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  configSchema: SchemaField[];
  stateSchema: SchemaField[];
  execution: ExecutionSettings;
  skills: SkillEntry[];
}

function defaultFormState(): FlowFormState {
  return {
    metadata: { name: "", displayName: "", description: "", author: "", tags: [] },
    prompt: "",
    services: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    stateSchema: [],
    execution: { timeout: 300, maxTokens: 8192, outputRetries: 2 },
    skills: [],
  };
}

function recordToFields(
  record: Record<string, Record<string, unknown>> | undefined,
  mode: "input" | "output" | "config" | "state",
): SchemaField[] {
  if (!record) return [];
  return Object.entries(record).map(([key, field]) => ({
    key,
    type: (field.type as string) || "string",
    description: (field.description as string) || "",
    required: !!field.required,
    ...(mode === "input"
      ? {
          placeholder: (field.placeholder as string) || "",
          default: field.default != null ? String(field.default) : "",
        }
      : {}),
    ...(mode === "config"
      ? {
          default: field.default != null ? String(field.default) : "",
          enumValues: Array.isArray(field.enum) ? field.enum.join(", ") : "",
        }
      : {}),
    ...(mode === "state" ? { format: (field.format as string) || "" } : {}),
  }));
}

function detailToFormState(detail: FlowDetail): FlowFormState {
  const services: ServiceEntry[] = detail.requires.services.map((s) => ({
    id: s.id,
    provider: s.provider,
    description: s.description,
    scopes: "",
  }));

  return {
    metadata: {
      name: detail.id,
      displayName: detail.displayName,
      description: detail.description,
      author: detail.author,
      tags: [],
    },
    prompt: detail.prompt || "",
    services,
    inputSchema: recordToFields(
      detail.input?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "input",
    ),
    outputSchema: recordToFields(
      detail.output?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "output",
    ),
    configSchema: recordToFields(
      detail.config?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "config",
    ),
    stateSchema: recordToFields(
      detail.stateSchema?.schema as unknown as Record<string, Record<string, unknown>> | undefined,
      "state",
    ),
    execution: {
      timeout: detail.executionSettings?.timeout ?? 300,
      maxTokens: detail.executionSettings?.maxTokens ?? 8192,
      outputRetries: detail.executionSettings?.outputRetries ?? 2,
    },
    skills: detail.rawSkills || [],
  };
}

function fieldsToRecord(
  fields: SchemaField[],
  mode: "input" | "output" | "config" | "state",
): Record<string, Record<string, unknown>> | null {
  const filtered = fields.filter((f) => f.key.trim());
  if (filtered.length === 0) return null;
  const record: Record<string, Record<string, unknown>> = {};
  for (const f of filtered) {
    const entry: Record<string, unknown> = { type: f.type };
    if (mode !== "state") {
      entry.description = f.description;
      entry.required = f.required;
    }
    if (mode === "input") {
      if (f.placeholder) entry.placeholder = f.placeholder;
      if (f.default) entry.default = f.default;
    }
    if (mode === "config") {
      if (f.default) entry.default = f.default;
      const enumVals = f.enumValues
        ?.split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (enumVals && enumVals.length > 0) entry.enum = enumVals;
    }
    if (mode === "state") {
      if (f.format) entry.format = f.format;
    }
    record[f.key.trim()] = entry;
  }
  return record;
}

function assemblePayload(state: FlowFormState) {
  const manifest: Record<string, unknown> = {
    version: "1.0",
    metadata: {
      name: state.metadata.name,
      displayName: state.metadata.displayName,
      description: state.metadata.description,
      author: state.metadata.author,
      ...(state.metadata.tags.length > 0 ? { tags: state.metadata.tags } : {}),
    },
    requires: {
      services: state.services
        .filter((s) => s.id && s.provider)
        .map((s) => {
          const svc: Record<string, unknown> = {
            id: s.id,
            provider: s.provider,
            description: s.description,
          };
          const scopes = s.scopes
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          if (scopes.length > 0) svc.scopes = scopes;
          return svc;
        }),
    },
  };

  const inputSchema = fieldsToRecord(state.inputSchema, "input");
  if (inputSchema) manifest.input = { schema: inputSchema };

  const outputSchema = fieldsToRecord(state.outputSchema, "output");
  if (outputSchema) manifest.output = { schema: outputSchema };

  const configSchema = fieldsToRecord(state.configSchema, "config");
  if (configSchema) manifest.config = { schema: configSchema };

  const stateSchema = fieldsToRecord(state.stateSchema, "state");
  if (stateSchema) manifest.state = { schema: stateSchema };

  manifest.execution = {
    timeout: state.execution.timeout,
    maxTokens: state.execution.maxTokens,
    outputRetries: state.execution.outputRetries,
  };

  const skills = state.skills
    .filter((s) => s.id && s.content)
    .map((s) => ({ id: s.id, description: s.description, content: s.content }));

  return { manifest, prompt: state.prompt, skills };
}

// --- Inner form component (receives initial state, no effects needed) ---

function FlowEditorForm({
  initialState,
  detail,
  flowId,
  isEdit,
}: {
  initialState: FlowFormState;
  detail: FlowDetail | null;
  flowId: string | undefined;
  isEdit: boolean;
}) {
  const navigate = useNavigate();
  const createFlow = useCreateFlow();
  const updateFlow = useUpdateFlow(flowId || "");

  const [form, setForm] = useState<FlowFormState>(initialState);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    setError(null);

    if (!form.metadata.name || !form.metadata.displayName || !form.metadata.description) {
      setError("Les champs identifiant, nom d'affichage et description sont requis.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (!form.prompt.trim()) {
      setError("Le prompt est requis.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const payload = assemblePayload(form);

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

      <MetadataSection
        value={form.metadata}
        onChange={(metadata) => setForm((s) => ({ ...s, metadata }))}
        isEdit={isEdit}
      />

      <PromptSection
        value={form.prompt}
        onChange={(prompt) => setForm((s) => ({ ...s, prompt }))}
      />

      <ServicesSection
        value={form.services}
        onChange={(services) => setForm((s) => ({ ...s, services }))}
      />

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

      <ExecutionSection
        value={form.execution}
        onChange={(execution) => setForm((s) => ({ ...s, execution }))}
      />

      <SkillsSection
        value={form.skills}
        onChange={(skills) => setForm((s) => ({ ...s, skills }))}
      />

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
  const { isAdmin } = useAuth();
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

  // Compute initial state once, pass to form as prop
  const initialState = isEdit && detail ? detailToFormState(detail) : defaultFormState();

  return (
    <FlowEditorForm
      key={flowId ?? "new"}
      initialState={initialState}
      detail={detail ?? null}
      flowId={flowId}
      isEdit={isEdit}
    />
  );
}
