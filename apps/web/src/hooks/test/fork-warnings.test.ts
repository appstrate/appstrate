// SPDX-License-Identifier: Apache-2.0

/**
 * Fork-time notices must REACH the user.
 *
 * A fork whose source `SKILL.md` predates the AFPS §3.3 rule still creates the
 * draft — that is how a user takes over a legacy skill they do not own — but
 * its published version is skipped, and the 201 says so in `warnings`. Both
 * halves of that path had dropped it: `useForkPackage`'s `mutationFn` returned
 * only `{ id, forked_from }`, and the modal navigated away in silence. The
 * fork then looked complete, and the missing version resurfaced much later as
 * "no published version".
 *
 * The two halves are exported as their own seams (`forkOutcome`,
 * `surfaceForkWarnings`) so both are observable: the web suite has no DOM, so
 * a mutation hook cannot be driven through a render here, and a test that
 * could not fail is worse than none.
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { toast } from "sonner";
import { forkOutcome, surfaceForkWarnings } from "../use-packages.ts";

describe("forkOutcome", () => {
  it("carries warnings through instead of dropping them", () => {
    expect(
      forkOutcome({
        id: "@me/gate-skill",
        forked_from: "@them/gate-skill",
        warnings: ["No version was published: fix SKILL.md, then publish."],
      }),
    ).toEqual({
      id: "@me/gate-skill",
      forked_from: "@them/gate-skill",
      warnings: ["No version was published: fix SKILL.md, then publish."],
    });
  });

  it("normalises a missing forked_from and leaves warnings absent", () => {
    expect(forkOutcome({ id: "@me/x" })).toEqual({
      id: "@me/x",
      forked_from: null,
      warnings: undefined,
    });
  });
});

describe("surfaceForkWarnings", () => {
  const spy = spyOn(toast, "warning");

  afterEach(() => spy.mockClear());

  it("raises one warning toast per notice", () => {
    surfaceForkWarnings(["first notice", "second notice"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["first notice", "second notice"]);
  });

  it("is silent when the fork did everything", () => {
    surfaceForkWarnings(undefined);
    surfaceForkWarnings([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
