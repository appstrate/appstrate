// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills pull <skill> [dir]` — a skill's files into a local working
 * folder: the draft by default (what `skills push` writes), or a published
 * version. The folder is a working copy, never a source; the lock the draft
 * carried at pull time is recorded so the next `skills push` from it needs no
 * `--force` unless the draft moved in between.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { apiFetch, ApiError } from "../lib/api.ts";
import {
  INSTALL_DIR_MARKER,
  packageWorkDir,
  readConfig,
  resolveActiveProfile,
  resolveWorkDir,
  type Profile,
} from "../lib/config.ts";
import { listOrgs } from "../lib/orgs.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { formatError } from "../lib/ui.ts";
import { fetchSkillFiles, listSyncableSkills, resolveSkill } from "../lib/skills-sync/plan.ts";
import { resolveSpaces } from "./skills.ts";
import { readPushLocks, writePushLocks } from "./skills-push.ts";

export interface SkillsPullOptions {
  profile?: string;
  /** `@scope/name`, or a bare name resolved under the organization's slug. */
  skill: string;
  /** Destination folder. Default: `<workDir>/<org slug>/packages/skills/<name>`. */
  dir?: string;
  /** A published version (`latest` or a semver) instead of the draft. */
  version?: string;
  /** Write into a folder that already has files, replacing same-named ones. */
  force?: boolean;
}

/** Packaging, not skill content; `manifest.json` stays so `push` keeps the id and version. */
const DROPPED = new Set(["RECORD"]);

export async function skillsPullCommand(
  opts: SkillsPullOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  if (!profile || !profile.orgId) {
    io.stderr.write(
      profile
        ? "No organization pinned. Run: appstrate org switch\n"
        : `Profile "${profileName}" not configured. Run: appstrate login --profile ${profileName}\n`,
    );
    io.exit(1);
    return;
  }

  let packageId: string;
  let dir: string;
  let name: string;
  try {
    const slug = await orgSlug(profileName, profile);
    packageId = opts.skill.startsWith("@") ? opts.skill : `@${slug}/${opts.skill}`;
    if (!parseScopedName(packageId)) throw new Error(`Not a package id: ${packageId}`);
    name = parseScopedName(packageId)!.name;
    const config = await readConfig();
    if (!opts.dir) await assertNotInstallDir(resolveWorkDir(config));
    dir = opts.dir ? resolve(opts.dir) : packageWorkDir(config, slug, "skill", name);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }

  try {
    await assertWritable(dir, opts.force === true);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
    return;
  }

  try {
    // The package routes only answer for a space the skill is installed in.
    const spaceIds = await resolveSpaces(profileName, profile, undefined);
    const listed = (await listSyncableSkills(profileName, spaceIds)).find(
      (entry) => entry.packageId === packageId,
    );
    if (!listed) {
      throw new Error(
        `${packageId} is not installed in the space(s) this profile syncs (${spaceIds.join(", ")}). Install it there, or pin another space.`,
      );
    }

    const source = opts.version ? "published" : "draft";
    const skill =
      opts.version && opts.version !== "latest"
        ? await resolveExactVersion(profileName, listed.packageId, listed.spaceId, opts.version)
        : await resolveSkill(profileName, listed, source);
    if (!skill) {
      throw new Error(
        source === "draft"
          ? `${packageId} has no draft.`
          : `${packageId} has no published version.`,
      );
    }

    // The draft detail carries two things the files alone do not: the manifest
    // (the draft file index omits it, as the sync wants) and the lock at pull
    // time, which the next push must name to prove nobody edited the draft since.
    const detail = await apiFetch<{ lock_version?: unknown; manifest?: unknown }>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}`,
      { headers: { "X-Space-Id": listed.spaceId } },
    ).catch(() => ({}) as { lock_version?: unknown; manifest?: unknown });

    const files = await fetchSkillFiles(profileName, skill, source);
    if (
      !files["manifest.json"] &&
      source === "draft" &&
      typeof detail.manifest === "object" &&
      detail.manifest !== null
    ) {
      files["manifest.json"] = new TextEncoder().encode(
        `${JSON.stringify(detail.manifest, null, 2)}\n`,
      );
    }
    const paths = Object.keys(files)
      .filter((path) => !DROPPED.has(path))
      .sort();
    for (const path of paths) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, files[path]!);
    }

    if (typeof detail.lock_version === "number") {
      const locks = await readPushLocks(profileName);
      locks[packageId] = detail.lock_version;
      await writePushLocks(profileName, locks);
    }

    const what = source === "draft" ? "draft" : `version ${skill.version}`;
    io.stdout.write(`Pulled ${packageId} (${what}, ${paths.length} files) into ${dir}\n`);
    // In the work dir the bare name is enough; elsewhere the path is the handle.
    const handle = opts.dir ? dir : name;
    io.stderr.write(`Edit it there, then: appstrate skills push ${handle}\n`);
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    io.exit(1);
  }
}

async function resolveExactVersion(
  profileName: string,
  packageId: string,
  spaceId: string,
  version: string,
) {
  try {
    const detail = await apiFetch<{ version?: unknown; integrity?: unknown; content?: unknown }>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}/versions/${encodeURIComponent(version)}`,
      { headers: { "X-Space-Id": spaceId } },
    );
    if (typeof detail.version !== "string" || typeof detail.integrity !== "string") {
      throw new Error(
        `Version detail for ${packageId}@${version} is missing version or integrity.`,
      );
    }
    return {
      packageId,
      spaceId,
      version: detail.version,
      integrity: detail.integrity,
      frontmatterName: "",
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new Error(`${packageId} has no version ${version}.`, { cause: err });
    }
    throw err;
  }
}

/** `~/Appstrate` is an instance directory that `uninstall --purge` removes: never a work dir. */
export async function assertNotInstallDir(workDir: string): Promise<void> {
  try {
    await stat(join(workDir, INSTALL_DIR_MARKER));
  } catch {
    return;
  }
  throw new Error(
    `${workDir} is an Appstrate instance directory (it has ${INSTALL_DIR_MARKER}); \`appstrate uninstall --purge\` would delete your working copies. Set workDir in config.toml to another folder.`,
  );
}

/** Empty or absent, unless `force`: a working folder is not overwritten by accident. */
async function assertWritable(dir: string, force: boolean): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch {
    return; // absent: created on write
  }
  if (!info.isDirectory()) throw new Error(`${dir}: not a directory.`);
  if (force) return;
  const entries = (await readdir(dir)).filter((entry) => entry !== ".DS_Store");
  if (entries.length > 0) {
    throw new Error(
      `${dir} is not empty. Pick another folder, or re-run with --force to overwrite its files.`,
    );
  }
}

async function orgSlug(profileName: string, profile: Profile): Promise<string> {
  const org = (await listOrgs(profileName)).find((o) => o.id === profile.orgId);
  if (!org) throw new Error(`Organization ${profile.orgId} is not one this profile belongs to.`);
  return org.slug;
}
