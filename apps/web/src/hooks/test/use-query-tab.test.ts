// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { urlListParams } from "../../lib/list-params.ts";
import { queryTab } from "../use-query-tab.ts";

const OPTIONS = ["org", "space"] as const;

function url(initial: string) {
  let params = new URLSearchParams(initial);
  const calls: Array<{ replace: boolean }> = [];
  const setParams = ((
    update: (prev: URLSearchParams) => URLSearchParams,
    options?: { replace?: boolean },
  ) => {
    params = update(params);
    calls.push({ replace: options?.replace ?? false });
  }) as Parameters<typeof urlListParams>[1];
  return {
    calls,
    current: () => params.toString(),
    tab: () => queryTab(urlListParams(params, setParams, []), "tab", OPTIONS),
  };
}

describe("queryTab", () => {
  it("defaults to the first option and ignores an undeclared value", () => {
    expect(url("").tab()[0]).toBe("org");
    expect(url("tab=bogus").tab()[0]).toBe("org");
    expect(url("tab=space").tab()[0]).toBe("space");
  });

  it("pushes a switch and leaves the default out of the URL", () => {
    const u = url("q=mail");
    u.tab()[1]("space");
    expect(u.current()).toBe("q=mail&tab=space");
    u.tab()[1]("org");
    expect(u.current()).toBe("q=mail");
    expect(u.calls).toEqual([{ replace: false }, { replace: false }]);
  });
});
