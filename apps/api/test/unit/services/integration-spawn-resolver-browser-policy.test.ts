// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { privateConnectToolExposure } from "../../../src/services/integration-spawn-resolver.ts";

describe("private connect tool exposure", () => {
  it("removes browser and login hooks from an explicit agent allowlist", () => {
    expect(
      privateConnectToolExposure({
        wildcardSelection: false,
        effectiveSelection: ["read", "login", "acquire_session"],
        manifestHiddenTools: ["debug"],
        privateToolNames: ["login", "acquire_session"],
      }),
    ).toEqual({
      toolAllowlist: ["read"],
      hiddenTools: ["debug", "login", "acquire_session"],
    });
  });

  it("keeps private hooks hidden when wildcard disables the allowlist", () => {
    expect(
      privateConnectToolExposure({
        wildcardSelection: true,
        effectiveSelection: [],
        manifestHiddenTools: [],
        privateToolNames: [undefined, "acquire_session"],
      }),
    ).toEqual({ toolAllowlist: undefined, hiddenTools: ["acquire_session"] });
  });
});
