// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { getErrorMessage } from "@appstrate/core/errors";
import i18n from "../i18n";
import { ApiError, client, type components } from "../api/client";
import { PACKAGE_CONFIG, type PackageType } from "./use-packages";
import { invalidateIntegrationQueries } from "./use-integrations";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";

// NOTE on query keys: run-cache keys (["runs"], ["paginated-runs"], ["run"])
// are PINNED legacy keys — use-global-run-sync.ts patches them from SSE
// events, and the runs hooks are migrated with the same pinned keys. The
// package/agent keys stay legacy too (see the note in use-packages.ts).

export function onMutationError(err: Error) {
  // Skip the generic toast for missing_integration_connection (412) —
  // the RunAgentButton renders MissingConnectionsModal off `runAgent.error`
  // for that case. Showing both a toast AND the modal is noisy and the
  // toast carries strictly less info than the modal.
  if (err instanceof ApiError && err.code === "missing_integration_connection") {
    return;
  }
  toast.error(i18n.t("error.prefix", { message: getErrorMessage(err) }));
}

export function useSaveConfig(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      const { data } = await client.PUT("/api/agents/{scope}/{name}/config", {
        params: { path: splitPackageRef(packageId) },
        body: config,
      });
      return data!;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages", "agents"] });
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
      const { data } = await client.POST("/api/agents/{scope}/{name}/run", {
        params: {
          path: splitPackageRef(packageId),
          // Editor default: run the draft the user is editing. Explicit so
          // the server-side published-by-default (#636) never changes UI
          // behavior.
          query: { version: version ?? "draft" },
        },
        body: {
          // The spec types the free-form input object as `Record<string,
          // never>` — narrow the editor-built input; the server validates it
          // against the agent's input schema.
          ...(input !== undefined ? { input: input as Record<string, never> } : {}),
          ...(connectionOverrides !== undefined
            ? { connection_overrides: connectionOverrides }
            : {}),
        },
      });
      // 201 + the bare created Run resource (same shape as GET /runs/:id) —
      // the legacy `runId` alias was removed (#657).
      return data!;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      navigate(`/agents/${packageId}/runs/${data.id}`);
    },
    onError: onMutationError,
  });
}

export function useImportPackage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async ({
      file,
      force,
    }: {
      file: File;
      force?: boolean;
    }): Promise<{ packageId: string; type: string; warnings?: string[] }> => {
      const fd = new FormData();
      fd.append("file", file);
      // Multi-package bundles route to a different endpoint; the
      // single-package import endpoint can't decode them. Detect by
      // extension so users can drag both kinds into the same modal.
      if (file.name.toLowerCase().endsWith(".afps-bundle")) {
        const { data } = await client.POST("/api/packages/import-bundle", {
          // Multipart gap: the generated body types the binary part as
          // `string`. The FormData passes through the serializer untouched;
          // the browser sets the multipart boundary.
          body: { file },
          bodySerializer: () => fd,
        });
        return {
          packageId: data!.root_package_id,
          type: "agent" as const,
          warnings: data!.warnings,
        };
      }
      const { data } = await client.POST("/api/packages/import", {
        params: { query: force ? { force: true } : undefined },
        // Multipart gap — see above.
        body: { file },
        bodySerializer: () => fd,
      });
      return data!;
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
      const { data } = await client.POST("/api/packages/import-github", { body: { url } });
      return data!;
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
      const { data } = await client.POST("/api/runs/{id}/cancel", {
        params: { path: { id: runId } },
      });
      return data!;
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
      const { data } = await client.DELETE("/api/agents/{scope}/{name}/runs", {
        params: { path: splitPackageRef(packageId) },
      });
      return data!;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      qc.invalidateQueries({ queryKey: ["paginated-runs"] });
      qc.invalidateQueries({ queryKey: ["packages", "agents"] });
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
      await client.DELETE("/api/packages/agents/{scope}/{name}", {
        params: { path: splitPackageRef(packageId) },
      });
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
      await client.DELETE("/api/agents/{scope}/{name}/persistence/memories/{id}", {
        params: { path: { ...splitPackageRef(packageId), id: memoryId } },
      });
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
      const { data } = await client.DELETE("/api/agents/{scope}/{name}/persistence", {
        params: { path: splitPackageRef(packageId), query: { kind: "memory" } },
      });
      return data!;
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
  return useMutation({
    mutationFn: async (body: {
      id?: string;
      manifest: Record<string, unknown>;
      content: string;
      source_code?: string;
    }): Promise<{ id: string }> => {
      // 201 → the created package resource, bare (issue #657).
      switch (type) {
        case "agent": {
          const { data } = await client.POST("/api/packages/agents", {
            // The editor builds the manifest as a plain `Record<string,
            // unknown>`; createAgent's body keeps the strict AFPS
            // `AgentManifest` (the documented SDK contract). Assert only the
            // manifest field across that dynamic-object → typed boundary —
            // `content` stays checked, and the server validates the manifest
            // against the AFPS schema.
            body: {
              manifest: body.manifest as components["schemas"]["AgentManifest"],
              content: body.content,
            },
          });
          return { id: data!.id };
        }
        case "skill": {
          const { data } = await client.POST("/api/packages/skills", { body });
          return { id: data!.id };
        }
        case "integration": {
          const { data } = await client.POST("/api/packages/integrations", { body });
          return { id: data!.id };
        }
        case "mcp-server": {
          const { data } = await client.POST("/api/packages/mcp-servers", {
            // The JSON create variant requires an explicit kebab-case id —
            // the editor always supplies one for MCP-server packages.
            body: { ...body, id: body.id! },
          });
          return { id: data!.id };
        }
      }
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      if (type === "agent") qc.invalidateQueries({ queryKey: ["agents"] });
      if (type === "integration") void invalidateIntegrationQueries(qc);
      if (data.id) {
        navigate(packageDetailPath(type, data.id));
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
    }): Promise<{ id: string; lock_version: number }> => {
      const { data } = await client.PUT(`/api/packages/${cfg.path}/{scope}/{name}`, {
        params: { path: splitPackageRef(packageId) },
        // No cast needed: the body's explicit `{manifest, content,
        // source_code?, lock_version}` keys satisfy the skill/integration/
        // mcp-server update operations (generic-object manifest) in the
        // dynamic-path union, so the assignment typechecks directly.
        body,
      });
      // 200 → the updated package resource, bare (issue #657). The resource
      // carries the NEW `lock_version` optimistic-lock token.
      return { id: data!.id, lock_version: data!.lock_version ?? 0 };
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
        void invalidateIntegrationQueries(qc);
      }
      qc.invalidateQueries({ queryKey: ["version-info"] });
      navigate(packageDetailPath(type, packageId));
    },
    onError: onMutationError,
  });
}
