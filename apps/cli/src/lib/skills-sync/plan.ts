// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate code sync`. No bulk endpoint exists, so it is one
 * list call, one resolution call per package, and downloads only for what
 * changed; concurrency is capped because the package routes are rate limited.
 * Agent commands are rendered from their detail read and download nothing.
 */

import { apiFetchRaw, apiFetchWithHeaders, apiList, ApiError, problemFields } from "../api.ts";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { extractSkillMeta } from "@appstrate/core/validation";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  draftRefusal,
  fetchPackageDefinition,
  PackageDefinitionError,
} from "../package-definition.ts";
import {
  AGENT_SLUG_PREFIX,
  agentSlug,
  collisionSlug,
  materializeAgent,
  SKILL_ENTRY,
  skillSlug,
  treeIntegrity,
  type AgentLaunchView,
} from "./materialize.ts";
import {
  emptyTargetState,
  STATE_VERSION,
  sameContext,
  type SyncContext,
  type SyncState,
  type TargetState,
} from "./state.ts";
import { destinationExists, skillDir, targetRoot, type SyncTarget } from "./targets.ts";

export const MAX_CONCURRENCY = 8;

export type SkillSource = TargetState["source"];

class SkillSyncError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillSyncError";
  }
}

/**
 * `--source draft` NAMES the working copy, and every route that honours the
 * selector — the package detail, the file index and the draft archive —
 * reserves that act to whoever may write the package. One remedy for each of
 * the three refusals: a reader who hits the earliest one must not get a
 * thinner message than one whose grant is revoked mid-sync.
 */
const DRAFT_REMEDY = "Sync the published artifact with `--source published`.";

const DRAFT_NOT_WRITABLE = "draft_not_writable";

/** The author-only refusal: authority, not chance, so the next run is refused the same way. */
export function isDraftRefusal(err: unknown): boolean {
  return err instanceof PackageDefinitionError && err.code === DRAFT_NOT_WRITABLE;
}

interface PackageListRow {
  id: string;
  source?: string;
}

export interface ResolvedSkill {
  packageId: string;
  spaceId?: string;
  version: string;
  /** SRI for a published artifact, the draft and file-index ETags for a draft. */
  integrity: string;
  /** Frontmatter `name` of the skill's `SKILL.md`, empty when it has none. */
  frontmatterName: string;
}

interface SlugClaim {
  slug: string;
  /** Set when a collision forced the `<scope>-<name>` fallback (D4, D23). */
  renamedFrom?: string;
}

interface PlannedSkill extends ResolvedSkill, SlugClaim {
  kind: "skill";
}

interface PlannedAgent extends SlugClaim {
  kind: "agent";
  packageId: string;
  version: string;
  /** SRI of the rendered tree (D22): a template, lock or space change moves it. */
  integrity: string;
  files: Record<string, Uint8Array>;
}

export type PlannedEntry = PlannedSkill | PlannedAgent;

interface ListedPackage {
  packageId: string;
  system: boolean;
}

/**
 * Sorted by package id, which is what makes collision resolution reproducible
 * rather than server-order dependent.
 *
 * Both listings ARE the ACTIVE set, not merely the placed one. Activation is
 * what a space OFFERS — a package switched off there is one somebody decided the
 * space would not use, and writing it into the local Claude Code checkout anyway
 * would hand the switch no meaning outside the dashboard. A package switched back
 * on reappears on the next sync, because the sync reads this list every time.
 */
async function listActive(
  profileName: string,
  path: string,
  spaceId?: string,
): Promise<ListedPackage[]> {
  const rows = await apiList<PackageListRow>(profileName, path, { spaceId });
  return rows
    .filter((row) => typeof row.id === "string" && row.id.length > 0)
    .map((row) => ({ packageId: row.id, system: row.source === "system" }))
    .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0));
}

/** System skills are the platform's, not the organization's. */
export async function listSyncableSkills(profileName: string, spaceId?: string): Promise<string[]> {
  const listed = await listActive(profileName, "/api/packages/skills", spaceId);
  return listed.filter((row) => !row.system).map((row) => row.packageId);
}

/**
 * `GET /api/agents` answers `agents:run` alone: it is the launchable set the
 * MCP session of that space accepts (D19). System agents stay: they launch.
 */
export function listSyncableAgents(profileName: string, spaceId: string): Promise<ListedPackage[]> {
  return listActive(profileName, "/api/agents", spaceId);
}

/** Both kinds: `null` on 404, the author-only refusal when the draft is named. */
async function readDetail<T>(
  profileName: string,
  path: string,
  packageId: string,
  type: "skill" | "agent",
  spaceId?: string,
): Promise<{ body: T; headers: Headers } | null> {
  try {
    return await apiFetchWithHeaders<T>(profileName, path, { spaceId });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) return null;
      if (problemFields(err.body).code === DRAFT_NOT_WRITABLE) {
        throw draftRefusal(packageId, type, DRAFT_REMEDY);
      }
    }
    throw err;
  }
}

/** `null` means no published version — a note on stderr, not a failure. */
export async function resolveSkill(
  profileName: string,
  packageId: string,
  source: SkillSource,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  return source === "published"
    ? resolvePublished(profileName, packageId, spaceId)
    : resolveDraft(profileName, packageId, spaceId);
}

async function resolvePublished(
  profileName: string,
  packageId: string,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  interface VersionDetail {
    version?: unknown;
    integrity?: unknown;
    content?: unknown;
  }
  const read = await readDetail<VersionDetail>(
    profileName,
    `/api/packages/skills/${encodePackageIdPath(packageId)}/versions/latest`,
    packageId,
    "skill",
    spaceId,
  );
  if (!read) return null;
  const detail = read.body;
  if (typeof detail.version !== "string" || typeof detail.integrity !== "string") {
    throw new SkillSyncError(
      `Version detail for ${packageId} is missing version or integrity`,
      "The instance is running an incompatible API version.",
    );
  }
  return {
    packageId,
    ...(spaceId ? { spaceId } : {}),
    version: detail.version,
    integrity: detail.integrity,
    frontmatterName: frontmatterNameOf(detail.content),
  };
}

async function resolveDraft(
  profileName: string,
  packageId: string,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  interface DraftDetail {
    content?: unknown;
  }
  // This request names `?version=draft` as well, so for a non-author it is
  // the FIRST one refused — before `/files` below ever runs.
  const read = await readDetail<DraftDetail>(
    profileName,
    `/api/packages/skills/${encodePackageIdPath(packageId)}?version=draft`,
    packageId,
    "skill",
    spaceId,
  );
  if (!read) return null;
  const detail = read.body;
  const detailEtag = read.headers.get("etag") ?? "";
  // A draft has no immutable digest: the change token is the index ETag and
  // the draft's own ETag, the two values that DO move with its content.
  // BOTH requests name `?version=draft`, never leaving it to the route's
  // default: omitted, detail and file routes alike serve the definition the
  // DETAIL page renders — the published version for anyone who cannot write
  // the package — and the sync would read one definition's metadata against
  // the other's bytes, then write published bytes into a ledger that calls
  // them a draft.
  const res = await apiFetchRaw(
    profileName,
    `/api/packages/${encodePackageIdPath(packageId)}/files?version=draft`,
    { spaceId },
  );
  if (!res.ok) {
    const problem = problemFields(await res.json().catch(() => undefined));
    if (problem.code === DRAFT_NOT_WRITABLE) {
      throw draftRefusal(packageId, "skill", DRAFT_REMEDY);
    }
    throw new SkillSyncError(
      `Draft file index for ${packageId} failed: ${problem.detail ?? `HTTP ${res.status} ${res.statusText}`}`,
      "Re-run without `--source draft`, or check that the skill still exists.",
    );
  }
  const etag = res.headers.get("etag") ?? "";
  return {
    packageId,
    ...(spaceId ? { spaceId } : {}),
    version: "draft",
    integrity: `draft:${detailEtag}:${etag}`,
    frontmatterName: frontmatterNameOf(detail.content),
  };
}

/**
 * The agent's launch contract in the pinned space: its definition at the
 * selected version plus the space's input layer, in one read. `latest` is the
 * dist-tag the detail route resolves (exact → dist-tag → range), answering 404
 * when nothing is published; the pinned version is whatever it resolved to.
 */
export async function resolveAgent(
  profileName: string,
  packageId: string,
  source: SkillSource,
  spaceId: string,
): Promise<AgentLaunchView | null> {
  interface AgentDetailBody {
    display_name?: unknown;
    description?: unknown;
    version?: unknown;
    input?: unknown;
  }
  const selector = source === "draft" ? "draft" : "latest";
  const read = await readDetail<AgentDetailBody>(
    profileName,
    `/api/packages/agents/${encodePackageIdPath(packageId)}?version=${selector}`,
    packageId,
    "agent",
    spaceId,
  );
  if (!read) return null;
  const { body } = read;
  const version = source === "draft" ? "draft" : body.version;
  if (typeof version !== "string" || !isLaunchInput(body.input)) {
    throw new SkillSyncError(
      `Agent detail for ${packageId} is missing version or input`,
      "The instance is running an incompatible API version.",
    );
  }
  return {
    packageId,
    spaceId,
    version,
    title:
      typeof body.display_name === "string" && body.display_name.trim()
        ? body.display_name
        : packageId,
    description: typeof body.description === "string" ? body.description : "",
    input: body.input,
  };
}

function isLaunchInput(value: unknown): value is AgentLaunchView["input"] {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.values === "object" &&
    input.values !== null &&
    Array.isArray(input.locked_fields) &&
    input.locked_fields.every((field) => typeof field === "string")
  );
}

interface SlugAssignment {
  planned: PlannedEntry[];
  /** Agents whose command cannot be rendered: deterministic, so never kept as unresolved. */
  failed: { packageId: string; error: unknown }[];
}

/**
 * Newcomers collide in input order (sorted by package id); every skill before
 * any agent (D23). `incumbents` (slug → wanted package id) are never handed to
 * another package this run: an unattended sync must never make
 * `/appstrate:<slug>` launch a different one. A package takes its preferred
 * slug when free, else the one it holds, else a fallback.
 */
export function assignSlugs(
  skills: ResolvedSkill[],
  agents: AgentLaunchView[] = [],
  incumbents: ReadonlyMap<string, string> = new Map(),
): SlugAssignment {
  const nameOf = (packageId: string): string => parseScopedName(packageId)?.name ?? packageId;
  const taken = new Set<string>();
  const pick = (packageId: string, preferred: string, prefix: string): SlugClaim => {
    const blocked = new Set(taken);
    let own: string | undefined;
    for (const [slug, holder] of incumbents) {
      if (holder !== packageId) blocked.add(slug);
      else own ??= slug;
    }
    const slug = !blocked.has(preferred)
      ? preferred
      : (own ?? collisionSlug(packageId, blocked, prefix));
    return slug === preferred ? { slug } : { slug, renamedFrom: preferred };
  };

  const planned: PlannedEntry[] = skills.map((skill) => {
    const preferred = skillSlug(skill.frontmatterName, nameOf(skill.packageId));
    const naming = pick(skill.packageId, preferred, "");
    taken.add(naming.slug);
    return { ...skill, kind: "skill" as const, ...naming };
  });
  const failed: SlugAssignment["failed"] = [];
  for (const view of agents) {
    const { packageId, version } = view;
    try {
      const naming = pick(packageId, agentSlug(nameOf(packageId)), AGENT_SLUG_PREFIX);
      const files = materializeAgent(naming.slug, view);
      taken.add(naming.slug);
      planned.push({
        kind: "agent",
        packageId,
        version,
        integrity: treeIntegrity(files),
        files,
        ...naming,
      });
    } catch (error) {
      failed.push({ packageId, error });
    }
  }
  return { planned, failed };
}

/**
 * Both sources are one archive (`../package-definition.ts`); the published one
 * is checked against `X-Integrity` before anything is unpacked. A draft archive
 * read after resolution may be newer than the token recorded for it — the next
 * sync then sees the token move and fetches again, never the reverse.
 */
export function fetchSkillFiles(
  profileName: string,
  skill: ResolvedSkill,
  source: SkillSource,
): Promise<Record<string, Uint8Array>> {
  return fetchPackageDefinition(
    profileName,
    source === "published"
      ? {
          packageId: skill.packageId,
          spaceId: skill.spaceId,
          source,
          version: skill.version,
          integrity: skill.integrity,
        }
      : {
          packageId: skill.packageId,
          type: "skill",
          spaceId: skill.spaceId,
          source,
          refusalRemedy: DRAFT_REMEDY,
        },
  );
}

function frontmatterNameOf(content: unknown): string {
  return typeof content === "string" ? extractSkillMeta(content).name : "";
}

/** Slug assignment is global, so every plan indexes into the same map. */
export type EntriesBySlug = ReadonlyMap<string, PlannedEntry>;

export interface TargetPlan {
  target: SyncTarget;
  ledger: TargetState;
  write: string[];
  /** Carried over untouched: already current, or listed but unresolvable now. */
  keep: string[];
  /** Shared targets only: destination exists and is not ours. */
  blocked: string[];
  removed: string[];
  /** Ledger slugs whose `SKILL.md` is on disk — asked by three rules below. */
  present: ReadonlySet<string>;
  /** This target holds another connection's installation, being replaced whole. */
  contextChanged: boolean;
}

/** D18: only the plugin ships `.mcp.json`; an agent command anywhere else fails every run. */
export function targetCarries(target: SyncTarget, kind: PlannedEntry["kind"]): boolean {
  return kind === "skill" || target === "claude-plugin";
}

export interface Catalogue {
  bySlug: EntriesBySlug;
  /** Listed but unresolvable (id → kind), unlike "not published". Decides deletion. */
  unresolved: Map<string, PlannedEntry["kind"]>;
}

/**
 * A recorded `root` that does not match the current one describes a DIFFERENT
 * `~/.agents/skills` (cron, launchd and devcontainers resolve `HOME`
 * differently), so the ledger reads as empty and its directories are refused.
 */
export function ownedLedger(
  target: SyncTarget,
  state: SyncState,
  source: SkillSource,
  context: SyncContext,
): TargetState {
  const previous = state.targets[target];
  const root = targetRoot(target);
  return !previous || previous.root !== root ? emptyTargetState(source, root, context) : previous;
}

export async function diffTarget(
  target: SyncTarget,
  catalogue: Catalogue,
  state: SyncState,
  source: SkillSource,
  context: SyncContext,
): Promise<TargetPlan> {
  const ledger = ownedLedger(target, state, source, context);
  // A ledger from a build whose materializer differs is stale, but still owned.
  // An installation belonging to another connection is replaced whole, so its
  // preparation is all-or-nothing rather than graded per skill.
  const contextChanged =
    state.targets[target]?.root === targetRoot(target) && !sameContext(ledger.context, context);
  const stale = state.version !== STATE_VERSION || ledger.source !== source;
  const shared = target !== "claude-plugin";
  const wanted = new Map(
    [...catalogue.bySlug].filter(([, entry]) => targetCarries(target, entry.kind)),
  );
  const present = new Set<string>();
  for (const slug of Object.keys(ledger.managed)) {
    if (await isMaterialized(target, slug)) present.add(slug);
  }
  const plan: TargetPlan = {
    target,
    ledger,
    write: [],
    keep: [],
    blocked: [],
    removed: [],
    present,
    contextChanged,
  };

  for (const [slug, entry] of wanted) {
    const managed = ledger.managed[slug];
    if (!managed) {
      // The shared roots hold the user's own skills, and the swap deletes what
      // it renames aside — so an unproven destination is left alone.
      if (shared && (await destinationExists(target, slug))) plan.blocked.push(slug);
      else plan.write.push(slug);
      continue;
    }
    // Not redundant with the integrity check: a hand-deleted skill keeps a
    // matching entry and would read as up to date forever.
    const current =
      !stale &&
      managed.integrity === entry.integrity &&
      managed.packageId === entry.packageId &&
      present.has(slug);
    (current ? plan.keep : plan.write).push(slug);
  }

  // Deletion is decided against the CATALOGUE, never against what resolved: a
  // 500 on `versions/latest` is not evidence that a skill is gone.
  for (const slug of Object.keys(ledger.managed).sort()) {
    if (wanted.has(slug)) continue;
    // The plugin is rebuilt by COPYING carried-over directories.
    const keepable = catalogue.unresolved.has(ledger.managed[slug]!.packageId) && present.has(slug);
    (keepable ? plan.keep : plan.removed).push(slug);
  }
  plan.write.sort();
  plan.keep.sort();
  return plan;
}

/**
 * `<skillDir>/SKILL.md`, NOT "the directory exists": a directory outlives its
 * `SKILL.md` and would still match the ledger while loading nowhere.
 */
async function isMaterialized(target: SyncTarget, slug: string): Promise<boolean> {
  try {
    return (await lstat(join(skillDir(target, slug), SKILL_ENTRY))).isFile();
  } catch {
    return false;
  }
}
