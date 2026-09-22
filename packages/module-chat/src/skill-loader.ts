// SPDX-License-Identifier: Apache-2.0

/**
 * Read the SKILL.md bodies a turn's `/skill` mentions ask for.
 *
 * One in-process dispatch of `GET /api/packages/skills/{scope}/{name}` per
 * distinct id — the SAME route `getSkill` serves, carrying the caller's own
 * headers, so a mention is subject to exactly the authorization a load is and
 * nothing here decides who may read what.
 *
 * It NEVER throws: a mention that cannot be read becomes a line in the
 * transcript (`skill-mentions.ts`), because losing the user's question because
 * their attachment 404s is the wrong trade.
 */

import { encodePackageIdPath } from "@appstrate/core/naming";
import type { ChatPlatformDeps } from "./platform-services.ts";
import { spaceScopedHeaders } from "./prompt.ts";
import type { LoadedSkill } from "./skill-mentions.ts";

/**
 * How many distinct skills one conversation may direct-load. A context-budget
 * bound: every body is replayed into the projected history on EVERY later turn,
 * so ten at the 32 KiB cap is already 320 KiB of permanent conversation. Past
 * it the mention still renders, as a refusal naming the cap.
 */
export const MAX_MENTIONED_SKILLS = 10;

/** The refusal rendered for every id past {@link MAX_MENTIONED_SKILLS}. */
export const TOO_MANY_SKILLS_REASON = "too many skills mentioned in one conversation";

/** The fields one `getSkill` response contributes to a loaded skill. */
interface SkillDetail {
  content?: string | null;
  version?: string | null;
}

/** RFC 9457 problem fields the platform's error responses carry. */
interface ProblemLike {
  code?: unknown;
  title?: unknown;
}

/**
 * The reason shown for a non-OK read: the problem's machine `code` when the
 * body is one, else its human `title`, else the bare status. The code is
 * preferred because it is the stable half — `skills_read_forbidden` tells the
 * model (and the user reading the bubble) something a localized title may not.
 */
async function refusalReason(res: Response): Promise<string> {
  try {
    const problem = (await res.json()) as ProblemLike;
    if (typeof problem?.code === "string" && problem.code) return problem.code;
    if (typeof problem?.title === "string" && problem.title) return problem.title;
  } catch {
    // Not a problem document (empty body, HTML, truncated JSON) — fall through.
  }
  return `HTTP ${res.status}`;
}

/**
 * Load every mentioned skill, in parallel, for this caller in this space.
 *
 * Parallel because the ids are independent reads and a turn waits on all of
 * them before its projection is built: serializing ten dispatches would put ten
 * round trips on the TTFT path for no gain. The caller starts this alongside
 * the caller-context read (`chat-stream.ts` phase B) — it depends on the
 * session row for nothing.
 *
 * The returned map is keyed by package id and holds an entry for EVERY id it
 * was given, so the projection never has to distinguish "not asked for" from
 * "asked for and failed".
 */
export async function loadMentionedSkills(
  deps: ChatPlatformDeps,
  args: { origin: string; headers: Record<string, string>; spaceId: string },
  ids: readonly string[],
): Promise<Map<string, LoadedSkill>> {
  const distinct = [...new Set(ids)];
  const loadable = distinct.slice(0, MAX_MENTIONED_SKILLS);
  const refused = distinct.slice(MAX_MENTIONED_SKILLS);

  const loaded = await Promise.all(
    loadable.map(async (id): Promise<LoadedSkill> => {
      try {
        // `encodePackageIdPath`, never `encodeURIComponent` on the whole id:
        // the route's two path params are `{scope}` and `{name}`, so the `/`
        // between them must stay a separator and the `@` must stay on the
        // scope — percent-encoding the id whole produces a 404 on a route that
        // exists.
        const url = new URL(`/api/packages/skills/${encodePackageIdPath(id)}`, args.origin);
        const res = await deps.dispatch(
          new Request(url.toString(), { headers: spaceScopedHeaders(args.headers, args.spaceId) }),
        );
        if (!res.ok) return { package_id: id, error: await refusalReason(res) };
        const detail = (await res.json()) as SkillDetail;
        const body = typeof detail?.content === "string" ? detail.content : "";
        // A skill row with no SKILL.md has nothing to follow; saying so beats
        // injecting an empty "loaded" block the model would take as an
        // instruction to do nothing.
        if (!body) return { package_id: id, error: "the skill has no content" };
        return {
          package_id: id,
          version: typeof detail.version === "string" ? detail.version : null,
          body,
        };
      } catch (err) {
        return { package_id: id, error: String(err) };
      }
    }),
  );

  const out = new Map<string, LoadedSkill>();
  for (const skill of loaded) out.set(skill.package_id, skill);
  for (const id of refused) out.set(id, { package_id: id, error: TOO_MANY_SKILLS_REASON });
  return out;
}
