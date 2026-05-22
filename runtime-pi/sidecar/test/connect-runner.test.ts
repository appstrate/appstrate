// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { runConnectTool, type ConnectToolInvoker } from "../connect-runner.ts";
import type { ConnectToolContext } from "@appstrate/connect/connect";

describe("runConnectTool — orchestration + non-leak", () => {
  it("hands the tool field NAMES only — never the secret values", async () => {
    let seen: ConnectToolContext | undefined;
    const invoke: ConnectToolInvoker = async (_tool, ctx) => {
      seen = ctx;
      return { outputs: { JSESSIONID: "sess-123" } };
    };

    await runConnectTool(
      { authKey: "session", toolName: "login", inputFields: ["identifiant", "mot_de_passe"] },
      invoke,
    );

    expect(seen).toEqual({ authKey: "session", inputFields: ["identifiant", "mot_de_passe"] });
    // Invariant §1.2.1: nothing the runner passes the tool resembles a value.
    expect(JSON.stringify(seen)).not.toContain("s3cr3t");
  });

  it("validates the tool result against produces and assembles a bundle", async () => {
    const invoke: ConnectToolInvoker = async () => ({
      outputs: { JSESSIONID: "sess", AWSALB: "lb", incidental: "drop-me" },
      identityClaims: { account: "acct-1" },
      expiresAt: "2026-06-01T00:00:00.000Z",
    });

    const bundle = await runConnectTool(
      {
        authKey: "session",
        toolName: "login",
        inputFields: [],
        produces: ["JSESSIONID", "AWSALB"],
      },
      invoke,
    );

    // Projected down to exactly `produces`; `incidental` dropped.
    expect(bundle.outputs).toEqual({ JSESSIONID: "sess", AWSALB: "lb" });
    expect(bundle.identityClaims).toEqual({ account: "acct-1" });
    expect(bundle.expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("fails closed when the tool omits a declared output", async () => {
    const invoke: ConnectToolInvoker = async () => ({ outputs: { JSESSIONID: "sess" } });
    await expect(
      runConnectTool(
        {
          authKey: "session",
          toolName: "login",
          inputFields: [],
          produces: ["JSESSIONID", "AWSALB"],
        },
        invoke,
      ),
    ).rejects.toMatchObject({ reason: "missing_output" });
  });

  it("defaults expiresAt to null (durable) when the tool omits it", async () => {
    const invoke: ConnectToolInvoker = async () => ({ outputs: { cookie: "c" } });
    const bundle = await runConnectTool(
      { authKey: "session", toolName: "login", inputFields: [] },
      invoke,
    );
    expect(bundle.expiresAt).toBeNull();
  });
});
