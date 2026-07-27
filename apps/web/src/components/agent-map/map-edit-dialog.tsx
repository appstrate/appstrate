// SPDX-License-Identifier: Apache-2.0

/**
 * In-place editing from the visual map.
 *
 * Deliberately thin: it mounts the SAME widgets the agent editor uses
 * (`ResourceSection` for skills / integrations, `PromptEditor` for the prompt)
 * and saves through the SAME mutation (`useUpdatePackage`, which owns the cache
 * invalidations). Nothing about how a manifest is read or written lives here —
 * `getResourceEntries` / `setResourceEntries` remain the single round-trip for
 * that, wildcard tool selections and `integrations_configuration` included.
 *
 * What is edited is always the agent's own definition: the prompt as text, and
 * declared dependencies. The map never becomes a source the definition is
 * generated from.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import type { ResourceEntry } from "@appstrate/shared-types";
import { Modal } from "../modal";
import { Spinner } from "../spinner";
import { ResourceSection } from "../agent-editor/resource-section";
import { PromptEditor } from "../agent-editor/prompt-editor";
import { RuntimeToolsGroup } from "../agent-editor/runtime-tools-group";
import { SchemaSection, type SchemaField } from "../agent-editor/schema-section";
import {
  caretRange,
  fieldsToSchema,
  getResourceEntries,
  manifestToSchemaFields,
  setResourceEntries,
} from "../agent-editor/utils";
import { usePackageDetail } from "../../hooks/use-packages";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useActivateIntegration } from "../../hooks/use-integrations";
import { agentMapQueryKeyPrefix } from "../../hooks/use-agent-map";
import { LibraryPicker, type LibraryCandidate } from "./library-picker";

/**
 * Which manifest section the dialog edits.
 *
 * `runtime_tools` is what the memory card acts on: `note` and `pin` are platform
 * runtime tools granted per agent in the manifest (`manifest.runtime_tools`), not
 * installable dependencies — so the memory card's affordance opens the same
 * system-tools checklist the editor uses, which also covers `output` / `log` /
 * `publish_document`.
 */
export type MapEditKind =
  "prompt" | "skills" | "integrations" | "runtime_tools" | "input" | "output";

interface MapEditDialogProps {
  kind: MapEditKind | null;
  packageId: string;
  onClose: () => void;
}

export function MapEditDialog({ kind, packageId, onClose }: MapEditDialogProps) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  // Only fetched while open, and re-read on open so the draft starts from the
  // current definition rather than a stale cache entry.
  const { data: detail } = usePackageDetail("agent", kind ? packageId : undefined);

  if (!kind) return null;

  // Saving already refreshes the map, but a save is not the only thing that can
  // change it here: activating an integration takes effect immediately and
  // server-side, so cancelling right after would leave the card still claiming
  // the integration is inactive. Refreshing on the way out covers both.
  const closeAndRefresh = () => {
    void qc.invalidateQueries({ queryKey: agentMapQueryKeyPrefix });
    onClose();
  };

  const TITLES: Record<MapEditKind, string> = {
    prompt: "map.editPrompt",
    skills: "map.addSkill",
    runtime_tools: "map.systemTools",
    integrations: "map.addIntegration",
    input: "map.editInput",
    output: "map.editOutput",
  };
  const title = t(TITLES[kind]);

  return (
    <Modal open onClose={closeAndRefresh} title={title} className="sm:max-w-2xl">
      {detail?.manifest ? (
        // Keyed on the optimistic-lock token: a save bumps it, which remounts
        // the form on the freshly saved definition instead of keeping a draft
        // that no longer matches the server.
        <MapEditForm
          key={detail.lock_version}
          kind={kind}
          packageId={packageId}
          manifest={detail.manifest}
          prompt={detail.prompt ?? ""}
          lockVersion={detail.lock_version ?? 0}
          onClose={closeAndRefresh}
        />
      ) : (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}
    </Modal>
  );
}

function MapEditForm({
  kind,
  packageId,
  manifest,
  prompt,
  lockVersion,
  onClose,
}: {
  kind: MapEditKind;
  packageId: string;
  manifest: Record<string, unknown>;
  prompt: string;
  lockVersion: number;
  onClose: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const update = useUpdatePackage("agent", packageId, { redirect: false });
  const activate = useActivateIntegration();
  const [draftPrompt, setDraftPrompt] = useState(prompt);
  const [entries, setEntries] = useState<ResourceEntry[]>(() =>
    kind === "skills" || kind === "integrations" ? getResourceEntries(manifest, kind) : [],
  );
  const [runtimeTools, setRuntimeTools] = useState<string[]>(() =>
    Array.isArray(manifest.runtime_tools) ? (manifest.runtime_tools as string[]) : [],
  );
  // Schema fields live in local state exactly as in the package editor: a field
  // being typed has an empty key, and `fieldsToSchema` drops those — persisting
  // on every keystroke would delete the row you are in the middle of naming.
  const [schemaFields, setSchemaFields] = useState<SchemaField[]>(() =>
    kind === "input" || kind === "output" ? (manifestToSchemaFields(manifest)[kind] ?? []) : [],
  );
  // Catalogue integrations staged for activation-then-declaration on save.
  const [staged, setStaged] = useState<LibraryCandidate[]>([]);
  const [activating, setActivating] = useState(false);

  function toggleStaged(candidate: LibraryCandidate) {
    setStaged((prev) =>
      prev.some((c) => c.id === candidate.id)
        ? prev.filter((c) => c.id !== candidate.id)
        : [...prev, candidate],
    );
  }

  function writeManifest(declared: ResourceEntry[]) {
    // Clone before mutating: `setResourceEntries` writes in place, and the
    // manifest here is the React Query cache's object.
    const next = structuredClone(manifest);
    if (kind === "skills" || kind === "integrations") setResourceEntries(next, kind, declared);
    // `runtime_tools` is a flat top-level array (AFPS), not a dependency group —
    // dropped entirely when empty rather than written as `[]`.
    if (kind === "runtime_tools") {
      if (runtimeTools.length > 0) next.runtime_tools = runtimeTools;
      else delete next.runtime_tools;
    }
    // An emptied schema drops its wrapper rather than persisting `{}`, matching
    // the package editor — `input: {}` is not the same manifest as no input.
    if (kind === "input" || kind === "output") {
      const wrapper = fieldsToSchema(schemaFields, kind);
      if (wrapper) next[kind] = wrapper;
      else delete next[kind];
    }
    update.mutate(
      {
        manifest: next,
        content: kind === "prompt" ? draftPrompt : prompt,
        lock_version: lockVersion,
      },
      {
        onSuccess: () => {
          // The map is a projection of what we just changed, and it is the very
          // view the user is looking at — refetch it before closing.
          void qc.invalidateQueries({ queryKey: agentMapQueryKeyPrefix });
          onClose();
        },
      },
    );
  }

  const busy = update.isPending || activating;

  async function save() {
    if (staged.length === 0) {
      writeManifest(entries);
      return;
    }
    // Activate first, sequentially, and declare only what actually activated: a
    // dependency on an integration that failed to activate would put the agent
    // straight into `integration_not_active`. The hook surfaces its own error
    // toast per failure.
    setActivating(true);
    const activated: ResourceEntry[] = [];
    for (const candidate of staged) {
      try {
        await activate.mutateAsync({ params: { path: { packageId: candidate.id } } });
        activated.push({ id: candidate.id, version: caretRange(candidate.version) });
      } catch {
        /* toast already shown; keep going so one failure doesn't sink the rest */
      }
    }
    setActivating(false);
    writeManifest([...entries, ...activated]);
  }

  return (
    <>
      <div className="max-h-[60vh] overflow-y-auto">
        {kind === "prompt" ? (
          <PromptEditor value={draftPrompt} onChange={setDraftPrompt} />
        ) : kind === "runtime_tools" ? (
          <RuntimeToolsGroup selected={runtimeTools} onChange={setRuntimeTools} />
        ) : kind === "input" || kind === "output" ? (
          <SchemaSection
            title={kind === "input" ? t("agents:map.input") : t("agents:map.output")}
            mode={kind}
            fields={schemaFields}
            onChange={setSchemaFields}
          />
        ) : (
          <ResourceSection
            type={kind === "skills" ? "skill" : "integration"}
            title={kind === "skills" ? t("map.skills") : t("map.toolbox")}
            emptyLabel={kind === "skills" ? t("map.emptySkills") : t("map.emptyToolbox")}
            selectedEntries={entries}
            onChange={(updater) =>
              setEntries((prev) => (typeof updater === "function" ? updater(prev) : updater))
            }
          />
        )}
        {kind === "integrations" && (
          <LibraryPicker
            // Anything already declared is offered by `ResourceSection` above;
            // listing it twice would let the two lists disagree.
            activeIds={new Set(entries.map((e) => e.id))}
            selected={staged}
            onToggle={toggleStaged}
          />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t("common:btn.cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner /> : t("common:btn.save")}
        </Button>
      </div>
    </>
  );
}
