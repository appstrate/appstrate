// SPDX-License-Identifier: Apache-2.0

/**
 * A local runner's egress policy (#1819): which (host, port) skips the SSRF floor, and the floor a
 * runner listener derives from it. The listeners' own tests only check that they apply it.
 */

import { describe, it, expect } from "bun:test";

import { ssrfFloorFor } from "../helpers.ts";
import { compileRunnerEgressPolicy } from "../ssrf.ts";

type RunnerEgress = Parameters<typeof compileRunnerEgressPolicy>[0];

const literal = (uris: string[]): RunnerEgress => ({
  authorizedUris: uris,
  declaredUris: uris,
  allowAllUris: false,
});
const listed = (host: string) => host === "intranet.corp";

describe("compileRunnerEgressPolicy — skipsSsrfFloor", () => {
  it("exempts only the port a literal entry declares, the scheme's default when none", () => {
    const table: Array<[string, number, boolean]> = [
      ["https://intranet.corp/**", 443, true],
      ["https://intranet.corp/**", 8443, false],
      ["http://intranet.corp:8080/**", 8080, true],
      ["http://intranet.corp:8080/**", 80, false],
      ["tcp://intranet.corp:5432", 5432, true],
      ["tcp://intranet.corp:5432", 5433, false],
      ["https://intranet.corp:*/**", 5432, false],
    ];
    const actual = table.map(([uri, port]) => [
      uri,
      port,
      compileRunnerEgressPolicy(literal([uri]), listed).skipsSsrfFloor("intranet.corp", port),
    ]);
    expect(actual).toEqual(table);
  });

  it("exempts only a host the operator lists and a declared entry names, host and port", () => {
    const rendered = (uri: string, declared: string) => ({
      ...literal([uri]),
      declaredUris: [declared],
    });
    const table: Array<[string, RunnerEgress, (host: string) => boolean, number, boolean]> = [
      ["listed, declared literally", literal(["https://intranet.corp/**"]), listed, 443, true],
      ["not operator-listed", literal(["https://intranet.corp/**"]), () => false, 443, false],
      [
        "host a connection chose",
        rendered("https://intranet.corp/**", "https://{$credential.host}/**"),
        listed,
        443,
        false,
      ],
      [
        "port a connection chose",
        rendered("https://intranet.corp:8443/**", "https://intranet.corp:{$variable.port}/**"),
        listed,
        8443,
        false,
      ],
      [
        "port only a glob entry grants",
        literal(["https://intranet.corp/**", "https://*.corp:8443/**"]),
        listed,
        8443,
        false,
      ],
      [
        "allow_all_uris",
        { ...literal(["https://intranet.corp/**"]), allowAllUris: true },
        listed,
        443,
        false,
      ],
    ];
    const actual = table.map(([label, egress, internalHost, port]) => [
      label,
      compileRunnerEgressPolicy(egress, internalHost).skipsSsrfFloor("intranet.corp", port),
    ]);
    expect(actual).toEqual(table.map(([label, , , , expected]) => [label, expected]));
  });

  it("never exempts loopback: neither a loopback name nor an exempt name's loopback address", () => {
    const declared = ["localhost", "127.0.0.1", "foo.localhost", "intranet.corp"];
    const policy = compileRunnerEgressPolicy(
      literal(declared.map((h) => `http://${h}:8081/**`)),
      () => true,
    );
    const exempt = declared.map((h) => policy.skipsSsrfFloor(h, 8081));
    expect(exempt).toEqual([false, false, false, true]);

    const floor = ssrfFloorFor(policy, "intranet.corp", 8081, () => false);
    const addresses = ["127.0.0.1", "127.8.9.10", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1"];
    expect(addresses.map(floor)).toEqual(addresses.map(() => true));
    const elsewhere = ["10.0.0.5", "192.168.1.2", "intranet.corp"];
    expect(elsewhere.map(floor)).toEqual(elsewhere.map(() => false));
  });
});
