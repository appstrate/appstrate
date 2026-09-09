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
  for (const target of SYNC_TARGETS) {
    const ledger = state.targets[target];
    if (!ledger || ledger.root !== targetRoot(target)) continue;
    // One context per destination, so the target's own context answers for
    // every directory under it — there is nothing to decide per entry.
    if (ledger.context.profileName !== profileName) continue;
    if (target === "claude-plugin") {
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
    for (const slug of Object.keys(ledger.managed)) {
      try {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug))
          throw new Error("Invalid managed skill directory name");
        await removeManagedDir(skillDir(target, slug));
        delete ledger.managed[slug];
      } catch (error) {
        failures.push(`Could not remove ${target}/${slug}: ${String(error)}`);
      }
    }
    // A target whose removals all failed keeps its entries, so it keeps its
    // ledger: ownership is what makes the retry able to finish the job.
    if (Object.keys(ledger.managed).length === 0) delete state.targets[target];
  }
  await writeSyncState(state);
  return { warnings: failures, pluginReset };
}
