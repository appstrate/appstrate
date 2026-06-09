// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import i18n from "../i18n";
import { api, ApiError, buildQs, uploadFormData } from "../api";
import { PACKAGE_CONFIG, type PackageType } from "./use-packages";
import { packageDetailPath } from "../lib/package-paths";

export function onMutationError(err: Error) {
  // Skip the generic toast for missing_integration_connection (412) —
  // the RunAgentButton renders MissingConnectionsModal off `runAgent.error`
  // for that case. Showing both a toast AND the modal is noisy and the
  // toast carries strictly less info than the modal.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  toast.error(i18n.t("error.prefix", { message: err.message }));
}

export function useSaveConfig(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      return api(`/agents/${packageId}/config`, {
        method: "PUT",
        body: JSON.stringify(config),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
    onError: onMutationError,
  });
}

export interface RunAgentParams {
  input?: Record<string, unknown>;
  /**
   * Version selector forwarded as `?version=`: `"draft"`, `"published"`, or
   * a version spec. When omitted, the editor default `"draft"` is sent
   * explicitly — the API's own default is published-when-exists (#636), but
   * dashboard test-runs must keep executing the working copy the user is
   * looking at.
   */
  version?: string;
  /**
   * Per-integration connection picks for THIS run (#199 mechanism #2).
   * Flat map: `{ "@scope/integration": "<connectionId>" }` — one pick per
   * integration; the chosen connection carries its own `auth_key`. Wire
   * format validated by `input-parser.ts`. Surfaced from the must_choose
   * modal picker.
   */
  connectionOverrides?: Record<string, string>;
}

export function useRunAgent(packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (params?: RunAgentParams) => {
      const { input, version, connectionOverrides } = params ?? {};
      // Editor default: run the draft the user is editing. Explicit so the
      // server-side published-by-default (#636) never changes UI behavior.
      const qs = buildQs({ version: version ?? "draft" });
      const body: Record<string, unknown> = {};
      if (input !== undefined) body.input = input;
      if (connectionOverrides !== undefined) body.connection_overrides = connectionOverrides;
      return api<{ runId: string }>(`/agents/${packageId}/run${qs}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      navigate(`/agents/${packageId}/runs/${data.runId}`);
    },
    onError: onMutationError,
  });
}

export function useImportPackage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({ file, force }: { file: File; force?: boolean }) => {
      const fd = new FormData();
      fd.append("file", file);
      // Multi-package bundles route to a different endpoint; the
      // single-package import endpoint can't decode them. Detect by
      // extension so users can drag both kinds into the same modal.
      if (file.name.toLowerCase().endsWith(".afps-bundle")) {
        const res = await uploadFormData<{
          root_package_id: string;
          root_version: string;
          warnings?: string[];
        }>("/packages/import-bundle", fd);
        return {
          packageId: res.root_package_id,
          type: "agent" as const,
          warnings: res.warnings,
        };
      }
      const qs = force ? "?force=true" : "";
      return uploadFormData<{ packageId: string; type: string; warnings?: string[] }>(
        `/packages/import${qs}`,
        fd,
      );
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      // Non-blocking install-time warnings (AFPS §7.7) —
      // surface each one as a sonner warning toast so publishers see them
      // immediately after a successful import.
      if (data.warnings && data.warnings.length > 0) {
        for (const message of data.warnings) {
          toast.warning(message);
        }
      }
      navigate(`/${data.type === "agent" ? "agent" : data.type}s/${data.packageId}`);
    },
    onError: onMutationError,
  });
}

export function useImportFromGithub() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (url: string) => {
      return api<{ packageId: string; type: string }>("/packages/import-github", {
        method: "POST",
        body: JSON.stringify({ url }),
        headers: { "Content-Type": "application/json" },
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      navigate(`/${data.type === "agent" ? "agent" : data.type}s/${data.packageId}`);
    },
    onError: onMutationError,
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => {
      return api(`/runs/${runId}/cancel`, { method: "POST" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAgentRuns(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ deleted: number }>(`/agents/${packageId}/runs`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (packageId: string) => {
      await api(`/packages/agents/${packageId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      navigate("/");
    },
    onError: onMutationError,
  });
}

// --- Memory mutations (unified persistence) ---

export function useDeleteMemory(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (memoryId: number) => {
      return api(`/agents/${packageId}/persistence/memories/${memoryId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}

export function useDeleteAllMemories(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return api<{ memories_deleted: number; checkpoint_deleted: boolean }>(
        `/agents/${packageId}/persistence?kind=memory`,
        { method: "DELETE" },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-persistence"] });
    },
    onError: onMutationError,
  });
}

// --- Package (skill/tool) create/update mutations ---

export function useCreatePackage(type: PackageType) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (body: {
      id?: string;
      manifest: Record<string, unknown>;
      content: string;
      source_code?: string;
    }) => {
      return api<{ packageId: string }>(`/packages/${cfg.path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (type === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
      if (type === "integration") qc.invalidateQueries({ queryKey: ["integrations"] });
      if (data.packageId) {
        navigate(packageDetailPath(type, data.packageId));
      }
    },
    onError: onMutationError,
  });
}

export function useUpdatePackage(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = PACKAGE_CONFIG[type];
  return useMutation({
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      source_code?: string;
      lock_version: number;
    }) => {
      return api<{ lock_version: number }>(`/packages/${cfg.path}/${packageId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (type === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
      // An agent's tools drive the required OAuth scopes, so editing them
      // changes the per-integration agent-resolution verdict (e.g. a connection
      // flips to insufficient_scopes / needs reconnection). Invalidate the
      // integrations subtree on agent edits too, not only integration edits, so
      // the Connections tab verdict + badges refresh without a page reload.
      if (type === "agent" || type === "integration") {
        qc.invalidateQueries({ queryKey: ["integrations"] });
      }
      qc.invalidateQueries({ queryKey: ["version-info"] });
      navigate(packageDetailPath(type, packageId));
    },
    onError: onMutationError,
  });
}
