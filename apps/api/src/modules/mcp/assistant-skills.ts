// SPDX-License-Identifier: Apache-2.0

/**
 * System skills exposed by the platform MCP server.
 *
 * These `SKILL.md` files ship in `skills/` next to this module's code, so they
 * are present on EVERY instance with zero import, zero DB. The MCP server lists
 * a short index of them in its `instructions` and serves the full body on demand
 * via the `load_skill` tool (progressive disclosure). Because they live on the
 * platform MCP surface, EVERY orchestrator-level MCP consumer inherits them: the
 * built-in chat (both engines) AND any external MCP client (Claude Code, …)
 * connected to `/api/mcp/o/:org`. Sandboxed run agents reach only the sidecar
 * MCP server, never this one — so they never see these skills (that is the org
 * `dependencies.skills` path instead).
 *
 * They drive the ASSISTANT/orchestrator, not the agents. The whitelist is the
 * folder itself — `load_skill` can only ever read a SKILL.md shipped here.
 *
 * Format = Anthropic Agent Skills (same as Claude Code): YAML frontmatter
 * (`name` / `description`) + markdown body, plus optional `references/*.md`
 * loaded on demand (disclosure level 3).
 */

import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extractSkillMeta } from "@appstrate/core/validation";
import { logger } from "../../lib/logger.ts";

/** Skill names / reference ids are folder/file slugs — kebab-case only. The
 * guard is what makes path traversal impossible: a value that isn't a bare slug
 * never reaches the filesystem. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `skills/` sits beside this file in the module. apps/api runs from source
 * under Bun, so `import.meta.dir` is this module's directory at runtime. */
const skillsDir = resolve(import.meta.dir, "skills");

export interface AssistantSkillMeta {
  name: string;
  description: string;
}

let cachedIndex: AssistantSkillMeta[] | null = null;

/**
 * Scan `skills/<name>/SKILL.md` and parse each frontmatter into {name,
 * description}. Cached after the first call (the folder is static per deploy).
 * A folder whose name disagrees with its frontmatter `name`, or whose
 * description is empty, is skipped with a warning rather than poisoning the
 * index. Returns `[]` when the folder is absent (degrades, never throws).
 */
export function listAssistantSkills(): AssistantSkillMeta[] {
  if (cachedIndex) return cachedIndex;
  const out: AssistantSkillMeta[] = [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    cachedIndex = out;
    return out;
  }
  for (const name of entries.sort()) {
    if (!SLUG.test(name)) continue;
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    try {
      const { name: fmName, description } = extractSkillMeta(readFileSync(file, "utf8"));
      if (fmName !== name) {
        logger.warn("assistant skill name mismatch — skipped", {
          folder: name,
          frontmatter: fmName,
        });
        continue;
      }
      if (!description) {
        logger.warn("assistant skill missing description — skipped", { name });
        continue;
      }
      out.push({ name, description });
    } catch (err) {
      logger.warn("assistant skill unreadable — skipped", { name, err: String(err) });
    }
  }
  cachedIndex = out;
  return out;
}

/**
 * Render the `## Assistant skills` block for the MCP server `instructions`, or
 * "" when none are loadable. Injected BEFORE the operation index so it survives
 * the chat's Mistral instruction-trim (which cuts from `## Operation index`).
 */
export function renderAssistantSkillsIndex(): string {
  const skills = listAssistantSkills();
  if (!skills.length) return "";
  const lines = [
    "## Assistant skills",
    "Beyond the API operations, this instance ships skills that guide YOU on how to operate it. " +
      "When the user's intent matches one, call the `load_skill` tool with its name to read it in " +
      "full, then follow it before acting. A skill may point to a `references/<ref>.md` — load it " +
      "with `load_skill({ name, reference })`.",
  ];
  for (const s of skills) lines.push(`- \`${s.name}\` — ${s.description}`);
  return lines.join("\n");
}

/**
 * Read a skill body, or one of its references when `reference` is given. Returns
 * `null` when the (validated) target doesn't exist. Both args are checked
 * against the slug guard AND the scanned whitelist, and the resolved path is
 * asserted to stay under `skills/` — a request can only ever read code shipped
 * with the module.
 */
export function loadAssistantSkill(name: string, reference?: string): { content: string } | null {
  if (!SLUG.test(name)) return null;
  if (!listAssistantSkills().some((s) => s.name === name)) return null;

  let target: string;
  if (reference !== undefined) {
    if (!SLUG.test(reference)) return null;
    target = join(skillsDir, name, "references", `${reference}.md`);
  } else {
    target = join(skillsDir, name, "SKILL.md");
  }

  // Defence in depth: even with the slug guard, never read outside skills/.
  const resolved = resolve(target);
  if (resolved !== skillsDir && !resolved.startsWith(skillsDir + sep)) return null;
  if (!existsSync(resolved)) return null;

  try {
    return { content: readFileSync(resolved, "utf8") };
  } catch (err) {
    logger.warn("assistant skill read failed", { name, reference, err: String(err) });
    return null;
  }
}

/** Test hook: drop the cached index so a fresh scan runs on the next call. */
export function resetAssistantSkillsCache(): void {
  cachedIndex = null;
}
