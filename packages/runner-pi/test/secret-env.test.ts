// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { RUNTIME_SECRET_ENV_KEYS, receiveSecrets, splitSecretEnv } from "../src/secret-env.ts";

const SECRETS = Object.fromEntries(RUNTIME_SECRET_ENV_KEYS.map((key) => [key, `v-${key}`]));

describe("splitSecretEnv / receiveSecrets", () => {
  it("keeps every secret out of the env and round-trips them through the payload", () => {
    const { env, payload } = splitSecretEnv({
      ...SECRETS,
      AGENT_RUN_ID: "run_1",
      UNSET: undefined,
    });

    expect(env).toEqual({ AGENT_RUN_ID: "run_1" });
    expect(receiveSecrets(payload, env)).toEqual({ AGENT_RUN_ID: "run_1", ...SECRETS });
  });

  it("refuses a startup environment that still carries a secret", () => {
    const { payload } = splitSecretEnv(SECRETS);
    expect(() => receiveSecrets(payload, { SIDECAR_AUTH_TOKEN: "x" })).toThrow(
      /SIDECAR_AUTH_TOKEN must not be in the runtime's environment/,
    );
  });

  it.each([
    ["", /JSON/],
    ["[]", /expected a JSON object/],
    ['{"PATH":"/bin"}', /unexpected entry "PATH"/],
    ['{"SIDECAR_URL":1}', /unexpected entry "SIDECAR_URL"/],
  ])("refuses the malformed payload %p", (payload, error) => {
    expect(() => receiveSecrets(payload, {})).toThrow(error);
  });
});
