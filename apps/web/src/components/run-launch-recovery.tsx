// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { AgentIntegrationEntry } from "@appstrate/shared-types";
import { Modal } from "./modal";
import { LoadingState } from "./page-states";
import type { RunLauncher } from "../hooks/use-mutations";

/**
 * 409 recovery surface — lazy because it is a modal that only ever opens on a
 * failed run kickoff, while launch buttons sit in the eager entry graph (agent
 * list → card → button). Its subtree reaches `IntegrationConnectionPicker` →
 * `@appstrate/core/integration` → `@afps-spec/schema`, which instantiates AJV
 * at module scope; a static edge shipped AJV + semver (~144 kB raw) to every
 * visitor. Keep this import dynamic.
 */
const MissingConnectionsModal = lazy(() =>
  import("./missing-connections-modal").then((m) => ({ default: m.MissingConnectionsModal })),
);

/** The recovery modal of a `useRunLauncher` launch refused with a 409 — renders nothing otherwise. */
export function RunLaunchRecovery({
  launcher,
  packageId,
  integrationEntries,
}: {
  launcher: RunLauncher;
  packageId: string;
  /** The agent's declared integrations, so a fresh connection requests exactly its scopes. */
  integrationEntries: AgentIntegrationEntry[] | undefined;
}) {
  const { t } = useTranslation(["agents"]);
  if (launcher.missingErrors === null) return null;
  return (
    // Mounted only while the 409 modal is open — that mount is what triggers
    // the dynamic import. The fallback keeps the same modal frame so the
    // dialog appears immediately and only its body swaps.
    <Suspense
      fallback={
        <Modal open onClose={launcher.dismiss} title={t("missingConnections.title")}>
          <LoadingState />
        </Modal>
      }
    >
      <MissingConnectionsModal
        open
        onClose={launcher.dismiss}
        errors={launcher.missingErrors}
        agentPackageId={packageId}
        {...(integrationEntries ? { integrationEntries } : {})}
        retrying={launcher.isPending}
        // The modal stays open until the retry lands, so the picker is still
        // there if the server answers a fresh 409 (picks gone mid-flight).
        onRetryWithOverrides={launcher.retry}
      />
    </Suspense>
  );
}
