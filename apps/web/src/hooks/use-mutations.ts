// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type MutationMeta,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { client, type components } from "../api/client";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "./use-packages";
import { invalidateIntegrationQueries } from "./use-integrations";
import { invalidateLibraries } from "./use-library";
import { runDetailPath, splitPackageRef } from "../lib/package-paths";
import i18n from "../i18n";
import {
  packageKeys,
  agentsKeys,
  runKeys,
  paginatedRunsKeys,
  persistenceKeys,
  invalidatePackageFiles,
  invalidatePackageCaches,
  versionKeys,
} from "../lib/query-keys";
import {
  launchFlight,
  launchRefusal,
  retryLaunch,
  type LaunchRefusal,
  type RunLaunch,
} from "../lib/run-launch";
import { useLaunchWarningsToast } from "./use-launch-warnings-toast";

// Run-cache keys (["paginated-runs"], ["run"]) are PINNED legacy keys: use-global-run-sync.ts
// patches them from SSE. Package/agent keys stay legacy too (see use-packages.ts).

/** Persists the editor layer of input resolution; both members are FULL replacements (an omitted key is cleared), so always send the pair. */
export function useSaveInputSettings(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: { values: Record<string, unknown>; locked_fields: string[] }) => {
      const { data } = await client.PUT("/api/agents/{scope}/{name}/input-settings", {
        params: { path: splitPackageRef(packageId) },
        body: settings,
      });
      return data!;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
    },
  });
}

function useRunAgent(packageId: string) {
  const qc = useQueryClient();
  const toastWarnings = useLaunchWarningsToast();
  return useMutation({
    mutationFn: async (launch: RunLaunch) => {
      const {
        input,
        rerun_from,
        version,
        connectionOverrides,
        modelId,
        proxyId,
        generation,
        dependencyOverrides,
      } = launch;
      const { data } = await client.POST("/api/agents/{scope}/{name}/run", {
        params: {
          path: splitPackageRef(packageId),
          // Pass-through, NO default: omitted `version` means the server's default (`published`);
          // "run the working copy" is `version: "draft"` at the call site, never inferred here.
          query: { version },
        },
        body: {
          // The spec types free-form input as `Record<string, never>`; the server validates it.
          ...(input !== undefined ? { input: input as Record<string, never> } : {}),
          ...(rerun_from !== undefined ? { rerun_from } : {}),
          ...(connectionOverrides !== undefined
            ? { connection_overrides: connectionOverrides }
            : {}),
          ...(modelId !== undefined ? { modelId } : {}),
          ...(generation !== undefined ? { generation } : {}),
          ...(proxyId !== undefined ? { proxyId } : {}),
          ...(dependencyOverrides !== undefined
            ? { dependency_overrides: dependencyOverrides }
            : {}),
        },
      });
      return data!;
    },
    onSuccess: (data) => {
      // Stale, not refetched: every launch leaves for the run's own page.
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all, refetchType: "none" });
      toastWarnings({ kind: "run" }, packageId, data.warnings);
    },
  });
}

/**
 * The one way the SPA launches a run. A `409 missing_integration_connection` is a question: the
 * launcher keeps the refused launch and errors for `RunLaunchRecovery`, and `retry` replays it
 * without its own connection pick for the refused integrations (`retryLaunch`).
 */
export function useRunLauncher(packageId: string) {
  const runAgent = useRunAgent(packageId);
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<LaunchRefusal | null>(null);
  const replay = useRef<RunLaunch>({});
  const [isPending, setIsPending] = useState(false);
  const [flight] = useState(() => launchFlight(setIsPending));

  const send = (launch: RunLaunch) => {
    flight.run(
      () =>
        runAgent.mutateAsync(launch).then((run) => {
          navigate(runDetailPath(packageId, run.id));
        }),
      {
        onSuccess: () => setRefusal(null),
        // The mutation cache reports every failure; this picks up the 409.
        onError: (err) => {
          const refused = launchRefusal(err);
          if (!refused) return;
          setRefusal(refused);
          replay.current = retryLaunch(launch, refused.errors);
        },
      },
    );
  };

  return {
    isPending,
    missingErrors: refusal?.errors ?? null,
    missingVersion: refusal?.version,
    launch: send,
    retry: () => send(replay.current),
    dismiss: () => {
      // A retry still in flight must not reopen the modal.
      flight.forget();
      setRefusal(null);
    },
  };
}

export type RunLauncher = ReturnType<typeof useRunLauncher>;

/** After an import: refresh every package cache and surface the non-blocking import-time warnings. */
function afterImport(qc: QueryClient, data: { type: string; warnings?: string[] }) {
  // An import REPLACES the draft artifact: without the file caches the explorer shows the pre-import index.
  invalidatePackageCaches(qc);
  if (data.type === "integration") void invalidateIntegrationQueries(qc);
  for (const message of data.warnings ?? []) toast.warning(message);
  // The library feeds the integration editor's picker, which imports in place.
  void invalidateLibraries(qc);
}

/** `meta`: the import modal answers a refusal itself (overwrite and integrity prompts). */
export function useImportPackage(meta?: MutationMeta) {
  const qc = useQueryClient();
  return useMutation({
    meta,
    mutationFn: async ({
      file,
      force,
    }: {
      file: File;
      force?: boolean;
    }): Promise<{ packageId: string; type: string; version?: string; warnings?: string[] }> => {
      const fd = new FormData();
      fd.append("file", file);
      // Multi-package bundles route to a different endpoint; the
      // single-package import endpoint can't decode them. Detect by
      // extension so users can drag both kinds into the same modal.
      if (file.name.toLowerCase().endsWith(".afps-bundle")) {
        const { data } = await client.POST("/api/packages/import-bundle", {
          // Multipart gap: the generated body types the binary part as `string`; FormData passes through the serializer.
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
    onSuccess: (data) => afterImport(qc, data),
  });
}

export function useImportFromGithub() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async (url: string) => {
      const { data } = await client.POST("/api/packages/import-github", { body: { url } });
      return data!;
    },
    onSuccess: (data) => afterImport(qc, data),
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
      qc.invalidateQueries({ queryKey: runKeys.all });
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
    },
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
      toast.success(i18n.t("agents:detail.runsDeleted"));
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
    },
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
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
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
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
  });
}

// --- Package (skill/tool) create/update mutations ---

export function useCreatePackage(type: PackageType) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorHandledByCaller: true },
    // Exactly the keys the editor sends: the branches forward `body` whole and the create schemas are `.strict()`, so an unmodelled key is a 400.
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      operations?: components["schemas"]["PackageFileWriteOperation"][];
    }): Promise<{ id: string; version_count?: number }> => {
      switch (type) {
        case "mcp-server":
          throw new Error("MCP servers are created by importing their bundle");
        case "agent": {
          const { data } = await client.POST("/api/packages/agents", {
            // Assert only the manifest across the dynamic-object → strict `AgentManifest` boundary; the server validates it.
            body: {
              ...body,
              manifest: body.manifest as components["schemas"]["AgentManifest"],
            },
          });
          return data!;
        }
        case "skill": {
          const { data } = await client.POST("/api/packages/skills", { body });
          return data!;
        }
        case "integration": {
          const { data } = await client.POST("/api/packages/integrations", { body });
          return data!;
        }
      }
    },
    onSuccess: (data) => {
      // The create route skips the initial version when the publish gate would refuse it.
      if (data.version_count === 0) toast.warning(i18n.t("agents:editor.createdUnpublished"));
      qc.invalidateQueries({ queryKey: packageKeys.all });
      if (type === "agent") qc.invalidateQueries({ queryKey: agentsKeys.all });
      if (type === "integration") void invalidateIntegrationQueries(qc);
    },
  });
}

export function useUpdatePackage(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    // Callers build `body` via `packageUpdateBody` and never send `content`: the primary file is written as a file operation.
    meta: { errorHandledByCaller: true },
    mutationFn: async ({
      etag,
      body,
    }: {
      /** The draft version the edit is based on: sent as `If-Match`. */
      etag: string;
      body: {
        manifest: Record<string, unknown>;
        operations?: import("../lib/package-file-tree").PackageFileWriteOperation[];
      };
    }): Promise<{ id: string; etag: string | null }> => {
      const { data, response } = await client.PATCH(`/api/packages/${segment}/{scope}/{name}`, {
        params: { path: splitPackageRef(packageId), header: { "If-Match": etag } },
        body,
      });
      return { id: data!.id, etag: response.headers.get("ETag") };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // The saved bytes ARE what the Files tab shows.
      invalidatePackageFiles(qc);
      if (type === "agent") qc.invalidateQueries({ queryKey: agentsKeys.all });
      // An agent's tools drive the required OAuth scopes, so agent edits change the connection
      // verdicts too (e.g. insufficient_scopes): invalidate the integrations subtree for them as well.
      if (type === "agent" || type === "integration") {
        void invalidateIntegrationQueries(qc);
      }
      qc.invalidateQueries({ queryKey: versionKeys.infoAll });
    },
  });
}
