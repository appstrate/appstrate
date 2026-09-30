// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { client, type components } from "../api/client";
import { PACKAGE_TYPE_ROUTE_SEGMENT } from "@appstrate/core/package-files";
import type { PackageType } from "./use-packages";
import { invalidateIntegrationQueries } from "./use-integrations";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { onMutationError } from "../lib/mutation-error";
import {
  packageKeys,
  agentsKeys,
  runsKeys,
  runKeys,
  paginatedRunsKeys,
  persistenceKeys,
  invalidatePackageFiles,
} from "../lib/query-keys";
import { retryLaunch, type RunLaunch } from "../lib/run-launch";
import type { MissingIntegrationFieldError } from "../lib/connection-choice";
import { missingConnectionErrors } from "../lib/connection-choice";

// NOTE on query keys: run-cache keys (["runs"], ["paginated-runs"], ["run"])
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
    onError: onMutationError,
  });
}

function useRunAgent(packageId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (params?: RunLaunch) => {
      const {
        input,
        rerun_from,
        version,
        connectionOverrides,
        modelId,
        proxyId,
        generation,
        dependencyOverrides,
      } = params ?? {};
      const { data } = await client.POST("/api/agents/{scope}/{name}/run", {
        params: {
          path: splitPackageRef(packageId),
          // Pure pass-through — NO default here. Omitting `version` means the
          // server's unified default (`published`, #636), exactly as for any
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
      // 201 + the bare created Run resource (same shape as GET /runs/:id) —
      // the legacy `runId` alias was removed (#657).
      return data!;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
      navigate(`/agents/${packageId}/runs/${data.id}`);
    },
    onError: onMutationError,
  });
}

/**
 * The one way the SPA launches a run. A `409 missing_integration_connection`
 * is a question, not a failure: the launcher keeps the refused launch and the
 * server's errors, `RunLaunchRecovery` renders them as the recovery modal, and
 * `retry` replays that launch with the user's picks. The retried launch becomes
 * the kept one, so a second 409 builds on it: a pick one 409 dropped stays
 * dropped.
 */
export function useRunLauncher(packageId: string) {
  const runAgent = useRunAgent(packageId);
  const [missingErrors, setMissingErrors] = useState<MissingIntegrationFieldError[] | null>(null);
  const lastLaunch = useRef<{ launch: RunLaunch; onSuccess?: () => void }>({ launch: {} });

  const onError = (err: Error) => {
    const errors = missingConnectionErrors(err);
    if (errors) setMissingErrors(errors);
  };

  return {
    isPending: runAgent.isPending,
    missingErrors,
    /** `onSuccess` also fires when the recovery retry of this launch succeeds. */
    launch: (launch: RunLaunch, onSuccess?: () => void) => {
      lastLaunch.current = { launch, onSuccess };
      runAgent.mutate(launch, { onSuccess, onError });
    },
    retry: (picks: Record<string, string[]>) => {
      const { launch, onSuccess } = lastLaunch.current;
      const next = retryLaunch(launch, picks, missingErrors ?? []);
      lastLaunch.current = { launch: next, onSuccess };
      runAgent.mutate(next, {
        onSuccess: () => {
          setMissingErrors(null);
          onSuccess?.();
        },
        onError,
      });
    },
    dismiss: () => {
      setMissingErrors(null);
      runAgent.reset();
    },
  };
}

export type RunLauncher = ReturnType<typeof useRunLauncher>;

export function useImportPackage({
  navigateOnSuccess = true,
}: { navigateOnSuccess?: boolean } = {}) {
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // An import REPLACES the draft artifact, and this mutation navigates
      // straight to the detail page — without this the explorer renders the
      // pre-import index and the pre-import `inline` bodies until the query
      // goes stale.
      invalidatePackageFiles(qc);
      // Non-blocking import-time warnings (AFPS §7.7) —
      // surface each one as a sonner warning toast so publishers see them
      // immediately after a successful import.
      if (data.warnings && data.warnings.length > 0) {
        for (const message of data.warnings) {
          toast.warning(message);
        }
      }
      // The library lists servers for the integration editor's picker, which
      // imports in place and must see the new one.
      void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
      if (navigateOnSuccess) {
        navigate(packageDetailPath(data.type, data.packageId));
      }
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.all });
      // Same reason as `useImportPackage`: the draft artifact was replaced.
      invalidatePackageFiles(qc);
      navigate(packageDetailPath(data.type, data.packageId));
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
      qc.invalidateQueries({ queryKey: runKeys.all });
      qc.invalidateQueries({ queryKey: runsKeys.all });
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
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
      qc.invalidateQueries({ queryKey: runsKeys.all });
      qc.invalidateQueries({ queryKey: paginatedRunsKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
      qc.invalidateQueries({ queryKey: agentsKeys.all });
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
      qc.invalidateQueries({ queryKey: agentsKeys.all });
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
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
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
      qc.invalidateQueries({ queryKey: persistenceKeys.all });
    },
    onError: onMutationError,
  });
}

// --- Package (skill/tool) create/update mutations ---

export function useCreatePackage(type: PackageType) {
  const qc = useQueryClient();
  return useMutation({
    // Exactly the keys the editor sends: the skill/integration branches forward
    // this object whole and the create schemas are `.strict()`, so a key
    // declared here that the server does not model is a 400 rather than a
    // silent drop. `id` sat beside the retired `source_code` until #1128 took
    // that one; no caller ever passed either.
    mutationFn: async (body: {
      manifest: Record<string, unknown>;
      content: string;
      operations?: components["schemas"]["PackageFileWriteOperation"][];
    }): Promise<{ id: string }> => {
      // 201 → the created package resource, bare (issue #657).
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
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: packageKeys.all });
      if (type === "agent") qc.invalidateQueries({ queryKey: agentsKeys.all });
      if (type === "integration") void invalidateIntegrationQueries(qc);
    },
    onError: onMutationError,
  });
}

/**
 * `opts.redirect` (default true) keeps the editor's behaviour: a successful save
 * leaves the editor for the detail page. Callers that are ALREADY on the detail
 * page — the visual map's in-place edit dialogs — pass false, since navigating
 * would drop the URL hash and throw the user back to the default tab.
 */
export function useUpdatePackage(type: PackageType, packageId: string) {
  const qc = useQueryClient();
  const segment = PACKAGE_TYPE_ROUTE_SEGMENT[type];
  return useMutation({
    // Every caller builds `body` through `packageUpdateBody`, and none of them
    // sends the API's `content` field any more: a package's primary file is
    // one of its files, written as a file operation like the others.
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
      // 200 → the updated package resource, bare (issue #657); its `ETag` bases the next save.
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
    onError: onMutationError,
  });
}
