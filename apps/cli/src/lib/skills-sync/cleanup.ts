// SPDX-License-Identifier: Apache-2.0

import { shellArg } from "../shell.ts";
import { loginFix, setupNotice, writeNotice } from "./notice.ts";
import { getNoticePath, readSyncState, writeSyncState } from "./state.ts";
import {
  PLUGIN_NAME,
  SETUP_SLUG,
  SYNC_TARGETS,
  removeManagedDir,
  setupPluginFiles,
  skillDir,
  targetRoot,
  writeSetupPlugin,
} from "./targets.ts";

/**
 * Caller holds the sync lock. Failed removals keep their ownership for a later
 * logout, so their warnings say to retry; a warning a retry cannot fix says so.
 */
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
  const retry = `Retry appstrate logout --profile ${shellArg(profileName)}.`;
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
      // Best effort, as after a sync: the setup skill already carries the remedy.
      try {
        await writeNotice(setupNotice(fix));
      } catch (error) {
        failures.push(
          `Could not write ${getNoticePath()}: ${String(error)}; the setup plugin is in place and its /${PLUGIN_NAME}:${SETUP_SLUG} skill carries the remedy.`,
        );
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
