// SPDX-License-Identifier: Apache-2.0

/**
 * A list's filters live in the URL. A filter is pushed (Back undoes it), the
 * search is replaced (typing must not fill the history), `reset` clears every
 * dimension in ONE update (several in the same tick would each start from the
 * same location, and the last would win), and a value the screen does not
 * declare is dropped: the URL is user input.
 */

import { describe, expect, it } from "bun:test";
import { readList, urlListParams } from "../list-params.ts";

type Update = (prev: URLSearchParams) => URLSearchParams;

/** A `setSearchParams` that applies each update to `params` and records how it was asked. */
function recorder(initial: string) {
  let params = new URLSearchParams(initial);
  const calls: Array<{ replace: boolean }> = [];
  const setParams = ((update: Update, options?: { replace?: boolean }) => {
    params = update(params);
    calls.push({ replace: options?.replace ?? false });
  }) as Parameters<typeof urlListParams>[1];
  return {
    calls,
    current: () => params.toString(),
    list: (keys: readonly string[]) => urlListParams(params, setParams, keys),
  };
}

describe("urlListParams", () => {
  it("pushes a filter and removes the key when it is emptied", () => {
    const url = recorder("q=mail");
    url.list(["state"]).setValues("state")(["active", "inactive"]);
    expect(url.current()).toBe("q=mail&state=active%2Cinactive");
    url.list(["state"]).setValues("state")([]);
    expect(url.current()).toBe("q=mail");
    expect(url.calls).toEqual([{ replace: false }, { replace: false }]);
  });

  it("replaces the entry for the search", () => {
    const url = recorder("state=active");
    url.list(["state"]).setSearch("ma");
    expect(url.current()).toBe("state=active&q=ma");
    url.list(["state"]).setSearch("");
    expect(url.current()).toBe("state=active");
    expect(url.calls).toEqual([{ replace: true }, { replace: true }]);
  });

  it("resets every filter and the search in one update, leaving other params", () => {
    const url = recorder("state=active&origin=shared&q=mail&package=%40acme%2Fx");
    url.list(["state", "origin"]).reset();
    expect(url.calls).toHaveLength(1);
    expect(url.current()).toBe("package=%40acme%2Fx");
  });

  it("reads the search and the declared values back", () => {
    const url = recorder("q=mail&state=active,bogus");
    const list = url.list(["state"]);
    expect(list.search).toBe("mail");
    expect(list.values("state", ["active", "inactive"] as const)).toEqual(["active"]);
  });
});

describe("readList", () => {
  it("keeps only the values the screen declares", () => {
    expect(readList("active,<script>,inactive,", ["active", "inactive"])).toEqual([
      "active",
      "inactive",
    ]);
  });

  it("reads an absent or empty parameter as no choice", () => {
    expect(readList(null, ["active"])).toEqual([]);
    expect(readList("", ["active"])).toEqual([]);
  });
});
