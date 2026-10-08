// SPDX-License-Identifier: Apache-2.0

import { loginFix, logoutRetry } from "../remedy.ts";
import { renderNotice } from "./notice.ts";
import { getNoticePath, readSyncState, writeNotice, writeSyncState } from "./state.ts";
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
        "Skills ownership state is unreadable; files were preserved. Run `appstrate code sync` with your usual `--target` after reconnecting to recover ownership.",
      ],
    };
  const failures: string[] = [];
  const retry = logoutRetry(profileName);
  let pluginReset = false;
  for (const target of SYNC_TARGETS) {
    const ledger = state.targets[target];
    if (!ledger || ledger.root !== targetRoot(target)) continue;
    // One context per destination, so the target's own context answers for
    // every directory under it — there is nothing to decide per entry.
    if (ledger.context.profileName !== profileName) continue;
    if (target === "claude-plugin") {
      const fix = loginFix("Signed out", profileName, ledger.context.instance);
      try {
        await writeSetupPlugin(ledger.root, setupPluginFiles(fix));
      } catch (error) {
        failures.push(`Could not reset ${target}: ${String(error)}. ${retry}`);
        continue;
      }
      delete state.targets[target];
      pluginReset = true;
      // Best effort: the setup skill carries the same remedy.
      try {
        await writeNotice(renderNotice(fix, "setup"));
      } catch (error) {
        failures.push(`Could not update ${getNoticePath()}: ${String(error)}`);
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
        failures.push(`Could not remove ${target}/${slug}: ${String(error)}. ${retry}`);
      }
    }
    // A target whose removals all failed keeps its entries, so it keeps its
    // ledger: ownership is what makes the retry able to finish the job.
    if (Object.keys(ledger.managed).length === 0) delete state.targets[target];
  }
  await writeSyncState(state);
  return { warnings: failures, pluginReset };
}
