// SPDX-License-Identifier: Apache-2.0

/**
 * The mention loader, against a scripted in-process dispatch.
 *
 * Three things are pinned: the path it builds (two path params, not one
 * percent-encoded id), the space it asks in, and that no failure mode —
 * refusal, missing package, thrown dispatch, too many mentions — can reach the
 * caller as an exception.
 */

import { describe, expect, it } from "bun:test";
import type { ChatPlatformDeps } from "../src/platform-services.ts";
import {
  MAX_MENTIONED_SKILLS,
  TOO_MANY_SKILLS_REASON,
  loadMentionedSkills,
} from "../src/skill-loader.ts";

const ARGS = {
  origin: "http://127.0.0.1:3000",
  headers: { cookie: "session=abc", "x-org-id": "org_1", "x-space-id": "spc_other" },
  spaceId: "spc_1",
};

/** Deps whose dispatch is scripted per request and records every call. */
function fakeDeps(respond: (req: Request) => Response | Promise<Response>): {
  deps: ChatPlatformDeps;
  requests: Request[];
} {
  const requests: Request[] = [];
  return {
    deps: {
      dispatch: async (req) => {
        requests.push(req);
        return respond(req);
      },
      rateLimit: () => async (_c, next) => next(),
      resolveChatModel: async () => ({ subscription: false }),
      recordChatUsage: async () => {},
      checkUsageAllowed: async () => null,
    } as unknown as ChatPlatformDeps,
    requests,
  };
}

const problem = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

describe("loadMentionedSkills", () => {
  it("reads getSkill per id, on the entered space, and maps content/version", async () => {
    const { deps, requests } = fakeDeps(() =>
      Response.json({ content: "# Copilot", version: "1.2.0" }),
    );

    const loaded = await loadMentionedSkills(deps, ARGS, ["@appstrate/copilot"]);

    expect(loaded.get("@appstrate/copilot")).toEqual({
      package_id: "@appstrate/copilot",
      version: "1.2.0",
      body: "# Copilot",
    });
    const url = new URL(requests[0]!.url);
    // Two path params: the `@` stays on the scope and the `/` stays a
    // separator — `encodeURIComponent` on the whole id would 404 here.
    expect(url.pathname).toBe("/api/packages/skills/@appstrate/copilot");
    expect(requests[0]!.headers.get("x-space-id")).toBe("spc_1");
    expect(requests[0]!.headers.get("cookie")).toBe("session=abc");
  });

  it("carries the problem's code for a refused or missing read", async () => {
    const { deps } = fakeDeps((req) =>
      new URL(req.url).pathname.endsWith("/gone")
        ? problem(404, { code: "package_not_found", title: "Not Found" })
        : problem(403, { title: "Forbidden" }),
    );

    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/gone", "@acme/secret"]);

    expect(loaded.get("@acme/gone")).toEqual({
      package_id: "@acme/gone",
      error: "package_not_found",
    });
    // No `code` in the body — the title is the next best thing to show.
    expect(loaded.get("@acme/secret")).toEqual({ package_id: "@acme/secret", error: "Forbidden" });
  });

  it("falls back to the status when the error body is not a problem document", async () => {
    const { deps } = fakeDeps(() => new Response("<html>oops</html>", { status: 502 }));
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect(loaded.get("@acme/a")).toEqual({ package_id: "@acme/a", error: "HTTP 502" });
  });

  it("reports a skill row with no content rather than injecting an empty block", async () => {
    const { deps } = fakeDeps(() => Response.json({ content: null, version: "1.0.0" }));
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect(loaded.get("@acme/a")).toEqual({
      package_id: "@acme/a",
      error: "the skill has no content",
    });
  });

  it("never throws when the dispatch itself throws", async () => {
    const { deps } = fakeDeps(() => {
      throw new Error("socket hang up");
    });
    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a"]);
    expect((loaded.get("@acme/a") as { error: string }).error).toContain("socket hang up");
  });

  it("caps the conversation at MAX_MENTIONED_SKILLS and refuses the overflow", async () => {
    const { deps, requests } = fakeDeps(() => Response.json({ content: "x", version: null }));
    const ids = Array.from({ length: MAX_MENTIONED_SKILLS + 2 }, (_, i) => `@acme/s${i}`);

    const loaded = await loadMentionedSkills(deps, ARGS, ids);

    expect(requests).toHaveLength(MAX_MENTIONED_SKILLS);
    expect(loaded.size).toBe(ids.length);
    for (const id of ids.slice(MAX_MENTIONED_SKILLS)) {
      expect(loaded.get(id)).toEqual({ package_id: id, error: TOO_MANY_SKILLS_REASON });
    }
  });

  it("dedupes ids before spending a dispatch on them", async () => {
    const { deps, requests } = fakeDeps(() => Response.json({ content: "x", version: null }));
    await loadMentionedSkills(deps, ARGS, ["@acme/a", "@acme/a", "@acme/b"]);
    expect(requests).toHaveLength(2);
  });

  it("issues every read in parallel", async () => {
    let inFlight = 0;
    const gate = Promise.withResolvers<void>();
    const { deps } = fakeDeps(async () => {
      inFlight += 1;
      // Every dispatch is entered before any of them resolves — otherwise the
      // turn pays one round trip per mention on the TTFT path.
      if (inFlight === 3) gate.resolve();
      await gate.promise;
      return Response.json({ content: "x", version: null });
    });

    const loaded = await loadMentionedSkills(deps, ARGS, ["@acme/a", "@acme/b", "@acme/c"]);

    expect(inFlight).toBe(3);
    expect(loaded.size).toBe(3);
  });
});
