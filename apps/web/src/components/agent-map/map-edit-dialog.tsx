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
import { caretRange, getResourceEntries, setResourceEntries } from "../agent-editor/utils";
import { usePackageDetail } from "../../hooks/use-packages";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useActivateIntegration } from "../../hooks/use-integrations";
import { agentMapQueryKeyPrefix } from "../../hooks/use-agent-map";
import { LibraryPicker, type LibraryCandidate } from "./library-picker";

/** Which manifest section the dialog edits. */
export type MapEditKind = "prompt" | "skills" | "integrations";

interface MapEditDialogProps {
  kind: MapEditKind | null;
  packageId: string;
  onClose: () => void;
}

export function MapEditDialog({ kind, packageId, onClose }: MapEditDialogProps) {
  const { t } = useTranslation("agents");
  // Only fetched while open, and re-read on open so the draft starts from the
  // current definition rather than a stale cache entry.
  const { data: detail } = usePackageDetail("agent", kind ? packageId : undefined);

  if (!kind) return null;

  const title =
    kind === "prompt"
      ? t("map.editPrompt")
      : kind === "skills"
        ? t("map.addSkill")
        : t("map.addIntegration");

  return (
    <Modal open onClose={onClose} title={title} className="sm:max-w-2xl">
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
          onClose={onClose}
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
    kind === "prompt" ? [] : getResourceEntries(manifest, kind),
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
    if (kind !== "prompt") setResourceEntries(next, kind, declared);
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
