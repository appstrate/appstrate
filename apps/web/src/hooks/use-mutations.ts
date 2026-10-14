// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
} from "../lib/query-keys";
import {
  launchFlight,
  launchRefusal,
  retryLaunch,
  type LaunchRefusal,
  type RunLaunch,
} from "../lib/run-launch";
import { useLaunchWarningsToast } from "./use-launch-warnings-toast";

// NOTE on query keys: run-cache keys (["paginated-runs"], ["run"])
// are PINNED legacy keys — use-global-run-sync.ts patches them from SSE
// events, and the runs hooks are migrated with the same pinned keys. The
// package/agent keys stay legacy too (see the note in use-packages.ts).

/**
 * Persist the editor layer of input resolution for this space.
 *
 * Both members are FULL replacements — an omitted key is cleared, never left
 * unchanged — so the caller always sends the complete pair.
 */
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
          // Pure pass-through — NO default here. Omitting `version` means the
          // server's unified default (`published`), exactly as for any
          // API caller. The editor's "run the working copy" intent is encoded
          // explicitly at the call site (`version: "draft"`), never inferred
          // by this transport hook — so API and front agree on every selector.
          query: { version },
        },
        body: {
          // The spec types the free-form input object as `Record<string,
          // never>` — narrow the editor-built input; the server validates it
          // against the agent's input schema.
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
      // 201 + the bare created Run resource (same shape as GET /runs/:id).
      return data!;
    },
    onSuccess: (data) => {
      // Stale, not refetched: every launch leaves for the run's own page.
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all, refetchType: "none" });
      toastWarnings({ kind: "run" }, packageId, data.warnings);
    },
  });
}

interface LaunchOptions {
  /**
   * The launch comes from a form addressed in the URL (`?run=`, `?rerun=`):
   * the run page replaces the form's history entry, so Back does not reopen
   * it, and a refused launch leaves the form open with what was typed.
   */
  replace?: boolean;
}

/**
 * The one way the SPA launches a run. A `409 missing_integration_connection`
 * is a question, not a failure: the launcher keeps the refused launch and the
 * server's errors, `RunLaunchRecovery` renders them as the recovery modal, and
 * `retry` replays that launch without its own connection pick for the refused
 * integrations (`retryLaunch`), so each one binds what its row of the modal
 * shows. A replay refused in turn is replayed the same way, from what it sent.
 */
export function useRunLauncher(packageId: string) {
  const runAgent = useRunAgent(packageId);
  const navigate = useNavigate();
  const [refusal, setRefusal] = useState<LaunchRefusal | null>(null);
  // What `retry` sends: the refused launch, as `retryLaunch` replays it.
  const replay = useRef<{ launch: RunLaunch; options: LaunchOptions }>({
    launch: {},
    options: {},
  });
  const [isPending, setIsPending] = useState(false);
  const [flight] = useState(() => launchFlight(setIsPending));

  const send = (launch: RunLaunch, options: LaunchOptions = {}) => {
    flight.run(
      () =>
        runAgent.mutateAsync(launch).then((run) => {
          navigate(runDetailPath(packageId, run.id), { replace: options.replace });
        }),
      {
        onSuccess: () => setRefusal(null),
        // The mutation cache reports every failure; this picks up the 409.
        onError: (err) => {
          const refused = launchRefusal(err);
          if (!refused) return;
          setRefusal(refused);
          replay.current = { launch: retryLaunch(launch, refused.errors), options };
        },
      },
    );
  };

  return {
    isPending,
    missingErrors: refusal?.errors ?? null,
    missingVersion: refusal?.version,
    /** `options` also apply when the recovery retry of this launch succeeds. */
    launch: send,
    retry: () => send(replay.current.launch, replay.current.options),
    dismiss: () => {
      // A retry still in flight must not reopen the modal.
      flight.forget();
      setRefusal(null);
    },
  };
}

export type RunLauncher = ReturnType<typeof useRunLauncher>;

export function useImportPackage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorHandledByCaller: true },
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // An import REPLACES the draft artifact, and the import modal opens the
      // detail page straight away — without this the explorer renders the
      // pre-import index and the pre-import `inline` bodies until the query
      // goes stale.
      invalidatePackageFiles(qc);
      if (data.type === "integration") void invalidateIntegrationQueries(qc);
      // Non-blocking import-time warnings — surface each one as a sonner
      // warning toast so publishers see them immediately after a successful import.
      if (data.warnings && data.warnings.length > 0) {
        for (const message of data.warnings) {
          toast.warning(message);
        }
      }
      // The library lists servers for the integration editor's picker, which
      // imports in place and must see the new one.
      void invalidateLibraries(qc);
    },
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
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // Same reason as `useImportPackage`: the draft artifact was replaced.
      invalidatePackageFiles(qc);
      if (data.type === "integration") void invalidateIntegrationQueries(qc);
    },
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      navigate("/");
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
    // Exactly the keys the editor sends: the skill/integration branches forward
    // this object whole and the create schemas are `.strict()`, so a key
    // declared here that the server does not model is a 400 rather than a
    // silent drop.
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      operations?: components["schemas"]["PackageFileWriteOperation"][];
    }): Promise<{ id: string; version_count?: number }> => {
      // 201 → the created package resource, bare.
      switch (type) {
        case "mcp-server":
          throw new Error("MCP servers are created by importing their bundle");
        case "agent": {
          const { data } = await client.POST("/api/packages/agents", {
            // The editor builds the manifest as a plain `Record<string,
            // unknown>`; createAgent's body keeps the strict AFPS
            // `AgentManifest` (the documented SDK contract). Assert only the
            // manifest field across that dynamic-object → typed boundary —
            // `content` stays checked, and the server validates the manifest
            // against the AFPS schema.
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
    // Every caller builds `body` through `packageUpdateBody`, and none of them
    // sends the API's `content` field: a package's primary file is
    // one of its files, written as a file operation like the others.
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
      // 200 → the updated package resource, bare; its `ETag` bases the next save.
      return { id: data!.id, etag: response.headers.get("ETag") };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // The saved bytes ARE what the Files tab shows.
      invalidatePackageFiles(qc);
      if (type === "agent") qc.invalidateQueries({ queryKey: agentsKeys.all });
      // An agent's tools drive the required OAuth scopes, so editing them
      // changes the per-integration agent-resolution verdict (e.g. a connection
      // flips to insufficient_scopes / needs reconnection). Invalidate the
      // integrations subtree on agent edits too, not only integration edits, so
      // the Connections tab verdict + badges refresh without a page reload.
      if (type === "agent" || type === "integration") {
        void invalidateIntegrationQueries(qc);
      }
      qc.invalidateQueries({ queryKey: ["version-info"] });
    },
  });
}
