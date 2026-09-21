// SPDX-License-Identifier: Apache-2.0

/**
 * The default version a launch surface sends — the one rule both the plain Run
 * button and the "Run with options" modal read, so they cannot drift apart.
 *
 * What each case guards is the DIFFERENCE from the previous behaviour, where
 * every surface sent `"draft"` unless a per-space pin said otherwise: the
 * draft is now the author's alone, and this function answers absence for
 * everyone else. A surface that must hold a value in a `<Select>` spells
 * `"published"` instead — see the doc on `defaultRunVersion` for why the two
 * shapes coexist.
 */

import { describe, expect, it } from "bun:test";
import {
  defaultRunVersion,
  isVersioned,
  replayVersion,
  VERSION_DRAFT,
} from "../version-selector.ts";

describe("defaultRunVersion", () => {
  it("runs the working copy for a caller who can write the package in its home", () => {
    expect(defaultRunVersion(true)).toBe(VERSION_DRAFT);
  });

  it("sends NO selector for a caller who cannot — the server resolves latest published", () => {
    expect(defaultRunVersion(false)).toBeUndefined();
  });

  it("sends no selector while the detail is still in flight", () => {
    // `home_writable` is absent until the package read lands. Guessing `draft`
    // there is exactly the run the server answers 403 `draft_not_writable` to.
    expect(defaultRunVersion(undefined)).toBeUndefined();
  });

  it("answers with absence, not the word `published`", () => {
    // What the plain Run button sends: nobody picked anything, so nothing is
    // sent. The "Run with options" modal starts its `<Select>` on
    // `VERSION_PUBLISHED` instead and sends that word — a control the user
    // saw and left alone is a pick. Both resolve to the same definition.
    expect(isVersioned(defaultRunVersion(false))).toBe(false);
  });
});

describe("replayVersion", () => {
  it("replays a concrete version for anyone who can launch the agent", () => {
    expect(replayVersion("1.2.3", false)).toBe("1.2.3");
    expect(replayVersion("1.2.3", true)).toBe("1.2.3");
  });

  it("replays a draft run for its author", () => {
    expect(replayVersion(VERSION_DRAFT, true)).toBe(VERSION_DRAFT);
  });

  it("falls back to the published version for a caller who cannot write it", () => {
    // The case the whole rule exists for: a runner re-running someone's draft
    // run sent `version=draft` verbatim and now gets `403 draft_not_writable`.
    expect(replayVersion(VERSION_DRAFT, false)).toBeUndefined();
  });
});
