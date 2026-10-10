// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { warnOnUnreadEnvKeys } from "../../src/lib/unread-env-keys.ts";

type Call = { msg: string; fields: Record<string, unknown> };

function spy(): { calls: Call[]; warn: (msg: string, fields: Record<string, unknown>) => void } {
  const calls: Call[] = [];
  return {
    calls,
    warn: (msg, fields) => {
      calls.push({ msg, fields });
    },
  };
}

describe("warnOnUnreadEnvKeys", () => {
  it("reports present, unread keys under a platform namespace and nothing else", () => {
    const { calls, warn } = spy();
    const keys = warnOnUnreadEnvKeys(
      {
        RUN_TOKEN_SECRETS: "x",
        PATH: "/bin",
        SIDECAR_MAX_REQUEST_BODY_BYTES: "1",
        APPSTRATE_VERSION: "1",
        EMPTY_RUN_X: "",
        RUN_ADAPTR: "docker",
      },
      warn,
    );

    expect(keys).toEqual(["RUN_ADAPTR", "RUN_TOKEN_SECRETS"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fields.keys).toEqual(["RUN_ADAPTR", "RUN_TOKEN_SECRETS"]);
    expect(calls[0]!.fields.docs).toBe("docs/ENV.md#unread-keys");
  });

  // Coolify injects the resource env into every container.
  it("ignores the env of sibling containers and SDKs", () => {
    const { calls, warn } = spy();
    const keys = warnOnUnreadEnvKeys(
      {
        POSTGRES_DB: "x",
        POSTGRES_PASSWORD: "x",
        AWS_REGION: "x",
        MINIO_ROOT_USER: "x",
        DOCKER_GID: "999",
        RUN_ADAPTR: "docker",
      },
      warn,
    );

    expect(keys).toEqual(["RUN_ADAPTR"]);
    expect(calls).toHaveLength(1);
  });

  it("stays silent when every platform key is read", () => {
    const { calls, warn } = spy();
    const keys = warnOnUnreadEnvKeys(
      { PATH: "/bin", RUN_ADAPTER: "docker", NODE_ENV: "test" },
      warn,
    );

    expect(keys).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
