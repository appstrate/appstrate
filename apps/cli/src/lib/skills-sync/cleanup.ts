// SPDX-License-Identifier: Apache-2.0

import { readSyncState, writeSyncState } from "./state.ts";
import {
  SYNC_TARGETS,
  removeManagedDir,
  setupPluginFiles,
  skillDir,
  targetRoot,
  writeSetupPlugin,
} from "./targets.ts";

/** Caller holds the sync lock. Failed removals keep their ownership for a later logout. */
export async function cleanupProfileSkills(
  profileName: string,
): Promise<{ warnings: string[]; pluginReset: boolean }> {
  const { state, corrupt } = await readSyncState();
  if (corrupt)
    return {
      pluginReset: false,
      warnings: [
        "Skills ownership state is unreadable; files were preserved. Run skills sync after reconnecting to recover ownership.",
      ],
    };
  const failures: string[] = [];
  let pluginReset = false;
  let legacy = false;
  for (const target of SYNC_TARGETS) {
    const ledger = state.targets[target];
    if (!ledger || ledger.root !== targetRoot(target)) continue;
    if (!ledger.context) legacy = true;
    if (target === "claude-plugin") {
      if (ledger.context?.profileName !== profileName) continue;
      try {
        await writeSetupPlugin(
          ledger.root,
          setupPluginFiles("Signed out", `appstrate login --profile ${profileName}`),
        );
        delete state.targets[target];
        pluginReset = true;
      } catch (error) {
        failures.push(`Could not reset ${target}: ${String(error)}`);
      }
      continue;
    }
    for (const [slug, entry] of Object.entries(ledger.managed)) {
      const owner = entry.context === undefined ? ledger.context : entry.context;
      if (!owner) legacy = true;
      if (owner?.profileName !== profileName) continue;
      try {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
          throw new Error("Invalid managed skill directory name");
        await removeManagedDir(skillDir(target, slug));
        delete ledger.managed[slug];
      } catch (error) {
        failures.push(`Could not remove ${target}/${slug}: ${String(error)}`);
      }
    }
    if (Object.keys(ledger.managed).length === 0 && ledger.context?.profileName === profileName) {
      delete state.targets[target];
    }
  }
  await writeSyncState(state);
  if (legacy)
    failures.push(
      "Some skills have unknown legacy ownership and were preserved. Reconnect and run skills sync successfully before logging out again to adopt and clean them",
    );
  return { warnings: failures, pluginReset };
}
